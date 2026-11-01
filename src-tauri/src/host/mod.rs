//! One machine: the reach to it, the programs it runs, and its files.

use std::collections::HashMap;
use std::fmt::{self, Debug, Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

// `enum_dispatch` expands the `FileSystem` signatures here, so `Bytes` and
// `AsyncRead` stay in scope though this file names neither.
use anyhow::{Context as _, ensure};
use bytes::Bytes;
use enum_dispatch::enum_dispatch;
use hostaddr::HostAddr;
use pi_rpc::client::Client;
use tokio::io::AsyncRead;
use tokio::sync::watch;
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf};

use crate::bus::Bus;
use crate::channel::{Channel, Process};
use crate::session::{SHUTDOWN_GRACE, Session, SessionInfo, reap_process, store};
use crate::state::LocalDirs;

/// Maximum time an RPC command (`bash`, `compact`) may run before timing out on the client.
const RPC_REQUEST_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// The name of one connection. The frontend generates it.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct HostId(String);

impl HostId {
    #[cfg(test)]
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for HostId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

pub mod executor;
pub mod fs;
mod local;
mod ssh;

#[doc(inline)]
pub use executor::Executor;
use executor::*;
#[doc(inline)]
pub use fs::FileSystem;
use fs::*;
use ssh::trust::KnownHosts;

/// The pi release pie speaks to. The crate version mirrors it.
pub(crate) const PI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where and how pie reaches a machine.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum HostTarget {
    /// This machine, where pie itself runs.
    Local,
    /// A machine reached over SSH.
    Ssh {
        user: String,
        host: HostAddr<String>,
        auth: HostAuth,
    },
}

/// Credentials used to authenticate with an SSH host.
#[derive(Clone, serde::Deserialize)]
pub enum HostAuth {
    None,
    Password(String),
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
}

impl Debug for HostAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => formatter.write_str("None"),
            Self::Password(_) => formatter.write_str("Password(<redacted>)"),
            Self::Key {
                private_key,
                passphrase,
            } => formatter
                .debug_struct("Key")
                .field("bytes", &private_key.len())
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

/// The reach to one machine, one variant per transport.
#[derive(Debug)]
#[enum_dispatch(Executor, FileSystem)]
pub enum Host {
    Local(local::LocalHost),
    Ssh(ssh::SshHost),
}

/// Dials or initializes `target`, checks the release of `pi`, and answers the connection.
///
/// A `pi` that is not installed fails the connect. A `pi` of another release is
/// logged and the connection goes on, because the files of the machine stay usable.
pub async fn connect(
    id: HostId,
    target: HostTarget,
    bus: Bus,
    dirs: &LocalDirs,
) -> anyhow::Result<HostConnection> {
    // The SSH dial takes the bus for its host-key question; the watcher needs its own.
    let watcher = bus.clone();
    let host = match &target {
        HostTarget::Local => Host::Local(local::LocalHost::new(dirs)),
        HostTarget::Ssh { user, host, auth } => Host::Ssh(
            ssh::SshHost::connect(
                user,
                id.clone(),
                host.clone(),
                auth,
                bus,
                KnownHosts::new(dirs.known_hosts.clone()),
            )
            .await?,
        ),
    };

    let connection = HostConnection {
        id,
        target,
        host,
        sessions: Arc::new(RwLock::new(HostSessions::default())),
        ending: Arc::new(AtomicBool::new(false)),
    };

    // The reach is watched before the release is checked, so a link that goes away
    // during the check still reaches the frontend.
    tokio::spawn(watch_reach(
        connection.id.clone(),
        connection.openness(),
        watcher,
        Arc::clone(&connection.ending),
    ));

    let version = match connection
        .pi_version()
        .await
        .context("this machine does not answer `pi --version`")
    {
        Ok(version) => version,
        Err(error) => {
            let _ = connection.disconnect().await;
            return Err(error);
        }
    };
    if version != PI_VERSION {
        tracing::warn!(
            found = %version,
            expected = PI_VERSION,
            "the pi on this machine is not the release pie speaks to; the connection goes on"
        );
    }

    Ok(connection)
}

/// How often the reach of a connection is checked. A closed SSH transport is a flag
/// that only a check turns into an event.
const REACH_TICK: Duration = Duration::from_secs(1);

/// One cheap check of whether the reach to a machine is still open.
enum Reach {
    /// This machine: open while pie runs, so there is nothing to watch.
    Always,
    Ssh(Box<dyn Fn() -> bool + Send + Sync>),
}

impl Reach {
    fn is_open(&self) -> bool {
        match self {
            Self::Always => true,
            Self::Ssh(check) => check(),
        }
    }
}

/// What the frontend hears about the reach to one machine.
///
/// This is the only news of a link that goes away while nothing is being asked, so
/// it travels even when no command is in flight.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionState {
    /// The reach is open.
    Open { host: HostId },
    /// The reach ended on its own: the machine is unreachable.
    Ended { host: HostId },
}

impl crate::bus::Notification for ConnectionState {
    const EVENT_NAME: &'static str = "pi://connection/state";
}

/// Announces the reach of one connection until it ends.
///
/// An end that pie asked for is not announced: the caller that asked already knows.
async fn watch_reach(host: HostId, reach: Reach, bus: Bus, ending: Arc<AtomicBool>) {
    if bus
        .notify(ConnectionState::Open { host: host.clone() })
        .is_err()
    {
        return;
    }

    if matches!(reach, Reach::Always) {
        return;
    }

    loop {
        tokio::time::sleep(REACH_TICK).await;
        if reach.is_open() {
            continue;
        }
        if !ending.load(Ordering::Relaxed)
            && let Err(error) = bus.notify(ConnectionState::Ended { host })
        {
            tracing::warn!(%error, "the end of a connection did not leave");
        }
        return;
    }
}

/// The processes that run now, guarded inside a [`HostConnection`].
#[derive(Debug, Default)]
struct HostSessions {
    /// Active `pi --mode rpc` processes keyed by the conversation file they serve.
    attached: HashMap<Utf8TypedPathBuf, Arc<Session>>,
}

/// One connected machine: the target it was dialled with, the reach to it, and the pi
/// processes pie started on it.
#[derive(Debug)]
pub struct HostConnection {
    id: HostId,
    target: HostTarget,
    host: Host,
    sessions: Arc<RwLock<HostSessions>>,
    /// Set when pie itself ends the reach, so no end is announced for it.
    ending: Arc<AtomicBool>,
}

impl HostConnection {
    /// The name this connection was registered under.
    ///
    /// Two machines can hold the same conversation path, so every event a session
    /// of this connection sends names both.
    pub fn id(&self) -> &HostId {
        &self.id
    }

    /// The reach to the machine, with its [`Executor`] and [`FileSystem`].
    pub fn host(&self) -> &Host {
        &self.host
    }

    /// The target specification used to establish this connection (used by `reconnect`).
    pub fn target(&self) -> &HostTarget {
        &self.target
    }

    /// Whether the underlying transport to the machine is still open.
    pub fn is_open(&self) -> bool {
        match &self.host {
            Host::Local(_) => true,
            Host::Ssh(ssh) => ssh.is_open(),
        }
    }

    /// A check of the same fact that a task can hold after this connection is gone.
    fn openness(&self) -> Reach {
        match &self.host {
            Host::Local(_) => Reach::Always,
            Host::Ssh(ssh) => Reach::Ssh(ssh.openness()),
        }
    }

    /// Terminates all attached `pi` processes and closes the underlying transport if SSH.
    pub async fn disconnect(&self) -> anyhow::Result<()> {
        // Set first, so the watcher does not announce an end that pie itself asked for.
        self.ending.store(true, Ordering::Relaxed);

        let attached: Vec<Arc<Session>> = {
            let mut guard = self
                .sessions
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            std::mem::take(&mut guard.attached).into_values().collect()
        };

        for session in attached {
            if let Err(error) = session.shutdown().await {
                tracing::warn!(%error, path = %session.path(), "a pi process did not end cleanly");
            }
        }

        if let Host::Ssh(ssh) = &self.host {
            ssh.disconnect().await?;
        }
        Ok(())
    }

    /// Looks up a currently attached session by its conversation file.
    pub fn session(&self, path: &Utf8TypedPathBuf) -> Option<Arc<Session>> {
        let guard = self.sessions.read().unwrap_or_else(PoisonError::into_inner);
        guard.attached.get(path).cloned()
    }

    /// Lists all conversations stored on this machine, newest first.
    ///
    /// A conversation that runs now reports its live name and id, so a rename shows
    /// here without a rescan. The file's times stay, which is what the order uses.
    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>> {
        let family = self.host.family().await;
        let mut rows = store::load_catalog(&self.host, family).await?;

        {
            let guard = self.sessions.read().unwrap_or_else(PoisonError::into_inner);
            for session in guard.attached.values() {
                if let Some(row) = rows.iter_mut().find(|row| row.path == session.path()) {
                    let live = session.info();
                    row.id = live.id;
                    row.title = live.title;
                }
            }
        }

        Ok(rows)
    }

    /// The sessions that run on this machine now.
    pub fn attached_sessions(&self) -> Vec<SessionInfo> {
        let guard = self.sessions.read().unwrap_or_else(PoisonError::into_inner);
        guard
            .attached
            .values()
            .map(|session| session.info())
            .collect()
    }

    /// Starts `pi --mode rpc --session <path>` for an existing conversation and registers it.
    ///
    /// Two callers that attach one file at once get one pi: the second process is
    /// ended and the first session answers.
    pub async fn attach_session(
        &self,
        path: Utf8TypedPathBuf,
        bus: Bus,
    ) -> anyhow::Result<Arc<Session>> {
        if let Some(session) = self.session(&path) {
            return Ok(session);
        }

        let family = self.host.family().await;
        let entry = self.host.metadata(path.to_path()).await?;
        let mut info = store::scan_session_file(&self.host, &entry, family).await?;

        let home = self.host.home_dir().await?;
        let (channel, mut process) = self.spawn_pi(home.to_path(), Some(path.clone())).await?;
        let client = rpc_client(channel);
        let state = match initial_rpc_state(&client).await {
            Ok(state) => state,
            Err(error) => {
                abort_started_pi(&client, &mut process).await;
                return Err(error);
            }
        };
        info.apply_rpc_state(&state);

        let session = Arc::new(Session::new(path.clone(), info, client, process));
        // The handler is installed before the session is registered, because a second
        // caller that finds this session may prompt it before this one returns.
        session
            .install_extension(self.id.clone(), bus.clone())
            .await;

        // The write guard is released before any await: a `std` guard across an
        // await would make the command future `!Send`.
        let registered = {
            let mut guard = self
                .sessions
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            match guard.attached.get(&path) {
                Some(existing) => Err(Arc::clone(existing)),
                None => {
                    guard.attached.insert(path.clone(), Arc::clone(&session));
                    Ok(())
                }
            }
        };

        match registered {
            Ok(()) => {
                let sessions = Arc::clone(&self.sessions);
                let evicted = Arc::clone(&session);
                session.pump(self.id.clone(), bus, move || {
                    evict_if_same(&sessions, &path, &evicted);
                });
                Ok(session)
            }
            Err(existing) => {
                // The losing process starts no pump: it is never served, and an end
                // event for a conversation that stays attached would be a lie.
                if let Err(error) = session.shutdown().await {
                    tracing::warn!(%error, path = %path, "a second pi for one conversation did not end");
                }
                Ok(existing)
            }
        }
    }

    /// Starts `pi --mode rpc` on a brand-new conversation in `cwd` and registers it.
    pub async fn start_new_session(
        &self,
        cwd: Utf8TypedPath<'_>,
        bus: Bus,
    ) -> anyhow::Result<Arc<Session>> {
        let (channel, mut process) = self.spawn_pi(cwd, None).await?;
        let client = rpc_client(channel);
        let startup = async {
            let state = initial_rpc_state(&client).await?;

            let file = state
                .session_file
                .clone()
                .filter(|file| !file.is_empty())
                .context("pi started no conversation file")?;

            let family = self.host.family().await;
            let path = typed(file, family);
            let entry = self.host.metadata(path.to_path()).await?;
            let mut info = store::scan_session_file(&self.host, &entry, family).await?;
            info.apply_rpc_state(&state);
            Ok::<(Utf8TypedPathBuf, SessionInfo), anyhow::Error>((path, info))
        }
        .await;

        let (path, info) = match startup {
            Ok(started) => started,
            Err(error) => {
                abort_started_pi(&client, &mut process).await;
                return Err(error);
            }
        };

        let session = Arc::new(Session::new(path.clone(), info, client, process));
        session
            .install_extension(self.id.clone(), bus.clone())
            .await;

        // The write guard is released before any await: a `std` guard across an
        // await would make the command future `!Send`.
        {
            let mut guard = self
                .sessions
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            guard.attached.insert(path.clone(), Arc::clone(&session));
        }

        // The pump starts once the session is the one this connection serves, so a
        // notification can never describe a conversation the map does not hold.
        let sessions = Arc::clone(&self.sessions);
        let evicted = Arc::clone(&session);
        session.pump(self.id.clone(), bus, move || {
            evict_if_same(&sessions, &path, &evicted);
        });

        Ok(session)
    }

    /// Stops the `pi` process of `path` while keeping its conversation file on disk.
    pub async fn detach_session(&self, path: &Utf8TypedPathBuf) -> anyhow::Result<()> {
        let session = {
            let mut guard = self
                .sessions
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            guard.attached.remove(path)
        };

        match session {
            Some(session) => {
                session.shutdown().await?;
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Deletes a conversation file from disk (detaching it first if currently running).
    pub async fn delete_session(&self, path: &Utf8TypedPathBuf) -> anyhow::Result<()> {
        self.detach_session(path).await?;
        self.host.remove(path.to_path()).await
    }

    /// Stages an [`UploadSource`] onto this machine's upload cache directory, reporting bytes written.
    pub async fn upload_file(
        &self,
        source: UploadSource,
        progress: watch::Sender<u64>,
    ) -> anyhow::Result<UploadReceipt> {
        match &self.host {
            Host::Ssh(ssh) => ssh.uploader().upload(source, progress).await,
            Host::Local(local) => local.upload_file(source, progress).await,
        }
    }

    /// Spawns `pi --mode rpc` in `cwd`, optionally on the conversation file `session`.
    async fn spawn_pi(
        &self,
        cwd: Utf8TypedPath<'_>,
        session: Option<Utf8TypedPathBuf>,
    ) -> anyhow::Result<(Channel, Process)> {
        let family = self.host.family().await;
        let cwd = require_absolute(cwd)?;
        check_type(cwd, family)?;

        let mut command = Command::new("pi")
            .with_args(["--mode", "rpc"])
            .with_cwd(cwd.as_str());
        if let Some(path) = session {
            check_type(path.to_path(), family)?;
            command = command.with_args(["--session", path.as_str()]);
        }

        self.host.spawn(command).await
    }

    /// Probes `pi --version` on the target machine and returns its trimmed version string.
    pub async fn pi_version(&self) -> anyhow::Result<String> {
        let output = self
            .host
            .exec(Command::new("pi").with_arg("--version"))
            .await?;

        ensure!(
            output.exit_status.is_success(),
            "`pi --version` on this machine {}: {}",
            output.exit_status,
            String::from_utf8_lossy(&output.stderr).trim()
        );

        let version = String::from_utf8(output.stdout.to_vec())
            .context("`pi --version` printed a version pie cannot read")?;
        Ok(version.trim().to_owned())
    }
}

/// Builds a [`Client`] with a long request deadline (`bash`, `compact`) and a bounded close deadline.
fn rpc_client(channel: Channel) -> Client {
    Client::with_config(
        channel,
        pi_rpc::client::Config::default()
            .with_request_timeout(RPC_REQUEST_TIMEOUT)
            .with_close_timeout(SHUTDOWN_GRACE),
    )
}

/// Reads the initial conversation state from a newly started `pi` within the default 30s startup deadline.
async fn initial_rpc_state(client: &Client) -> anyhow::Result<pi_rpc::response::SessionState> {
    tokio::time::timeout(pi_rpc::client::DEFAULT_REQUEST_TIMEOUT, client.get_state())
        .await
        .context("pi did not answer with the state of its conversation in time")?
        .context("pi did not answer with the state of its conversation")
}

/// Closes `client` and reaps `process` when startup fails before a [`Session`] is registered.
async fn abort_started_pi(client: &Client, process: &mut Process) {
    if let Err(error) = client.close().await {
        tracing::debug!(%error, "the rpc client of a failed startup did not close cleanly");
    }
    if let Err(error) = reap_process(process).await {
        tracing::warn!(%error, "the pi process of a failed startup did not end");
    }
}

/// Removes `evicted` from `sessions` when it is still the registered session for `path`.
fn evict_if_same(sessions: &RwLock<HostSessions>, path: &Utf8TypedPathBuf, evicted: &Arc<Session>) {
    let mut guard = sessions.write().unwrap_or_else(PoisonError::into_inner);
    if guard
        .attached
        .get(path)
        .is_some_and(|current| Arc::ptr_eq(current, evicted))
    {
        guard.attached.remove(path);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use camino::Utf8PathBuf;
    use tempfile::TempDir;
    use typed_path::Utf8TypedPath;

    use super::*;
    use crate::host::executor::OsFamily;
    use crate::host::fs::{UploadSource, UploadStatus, typed};
    use crate::session::SessionTitle;

    /// A connection to this machine, with a temporary home and cache.
    fn connection(home: &TempDir, cache: &TempDir) -> HostConnection {
        let dirs = LocalDirs {
            home: Some(
                Utf8PathBuf::from_path_buf(home.path().to_path_buf()).expect("a UTF-8 path"),
            ),
            cache: Some(
                Utf8PathBuf::from_path_buf(cache.path().to_path_buf()).expect("a UTF-8 path"),
            ),
            known_hosts: Utf8PathBuf::default(),
        };

        HostConnection {
            id: HostId::new("test"),
            target: HostTarget::Local,
            host: Host::Local(local::LocalHost::new(&dirs)),
            sessions: Arc::new(RwLock::new(HostSessions::default())),
            ending: Arc::new(AtomicBool::new(false)),
        }
    }

    fn path(text: &str) -> Utf8TypedPathBuf {
        typed(text, OsFamily::Unix)
    }

    #[test]
    fn a_connection_state_names_its_connection() {
        use crate::bus::Notification as _;

        assert_eq!(
            serde_json::to_value(ConnectionState::Ended {
                host: HostId::new("work"),
            })
            .expect("a connection state serializes"),
            serde_json::json!({ "type": "ended", "host": "work" })
        );
        assert_eq!(ConnectionState::EVENT_NAME, "pi://connection/state");
    }

    #[test]
    fn a_local_target_names_no_user() {
        let target: HostTarget =
            serde_json::from_str(r#"{"transport":"local"}"#).expect("a local target");
        assert!(matches!(target, HostTarget::Local));

        // A frontend that still sends the user it no longer needs is understood.
        let stale: HostTarget = serde_json::from_str(r#"{"transport":"local","user":"u"}"#)
            .expect("a stale local target");
        assert!(matches!(stale, HostTarget::Local));
    }

    #[test]
    fn an_ssh_target_carries_its_credentials() {
        let target: HostTarget = serde_json::from_str(
            r#"{"transport":"ssh","user":"u","host":{"host":{"domain":"example.test"},"port":null},"auth":{"Password":"secret"}}"#,
        )
        .expect("an ssh target");

        match target {
            HostTarget::Ssh { user, auth, .. } => {
                assert_eq!(user, "u");
                assert!(matches!(auth, HostAuth::Password(_)));
            }
            HostTarget::Local => panic!("the target is an ssh one"),
        }
    }

    #[test]
    fn a_credential_never_reaches_a_debug_line() {
        let key = HostAuth::Key {
            private_key: "-----BEGIN KEY-----\nsecret\n-----END KEY-----".to_owned(),
            passphrase: Some("secret".to_owned()),
        };
        let password = HostAuth::Password("secret".to_owned());

        for auth in [key, password] {
            let printed = format!("{auth:?}");
            assert!(!printed.contains("secret"), "{printed}");
        }
    }

    #[tokio::test]
    async fn a_session_file_of_this_machine_is_listed() {
        let home = tempfile::tempdir().expect("a temporary home");
        let cache = tempfile::tempdir().expect("a temporary cache");
        let sessions = home.path().join(".pi/agent/sessions/--work--");
        fs::create_dir_all(&sessions).expect("the session directory");
        fs::write(
            sessions.join("2025-09-01T10-00-00-000Z_0193.jsonl"),
            concat!(
                r#"{"type":"session","id":"0193","cwd":"/work","timestamp":"2025-09-01T10:00:00.000Z"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":"fix the bug"}}"#,
                "\n",
            ),
        )
        .expect("the session file");

        let rows = connection(&home, &cache)
            .list_sessions()
            .await
            .expect("the catalog");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id.as_str(), "0193");
        assert_eq!(
            rows[0].path.to_path().file_name(),
            Some("2025-09-01T10-00-00-000Z_0193.jsonl")
        );
        assert_eq!(rows[0].title, SessionTitle::FromFirstPrompt);
        assert_eq!(rows[0].first_prompt.as_deref(), Some("fix the bug"));
    }

    #[tokio::test]
    async fn a_conversation_no_pi_serves_is_not_attached() {
        let home = tempfile::tempdir().expect("a temporary home");
        let cache = tempfile::tempdir().expect("a temporary cache");
        let connection = connection(&home, &cache);
        let path = path("/nowhere/2025-09-01T10-00-00-000Z_0193.jsonl");

        assert!(connection.session(&path).is_none());
        connection
            .detach_session(&path)
            .await
            .expect("a file no pi serves is already detached");
    }

    #[tokio::test]
    async fn a_local_upload_is_staged_once_and_then_met_again() {
        let home = tempfile::tempdir().expect("a temporary home");
        let cache = tempfile::tempdir().expect("a temporary cache");
        let connection = connection(&home, &cache);
        let source = UploadSource::InMemory {
            name: "note.txt".to_owned(),
            content: Bytes::from_static(b"hello"),
        };

        let (report, _) = watch::channel(0u64);
        let fresh = connection
            .upload_file(source.clone(), report)
            .await
            .expect("the file is staged");

        assert_eq!(fresh.status, UploadStatus::UploadedFresh);
        assert_eq!(fresh.total_bytes, 5);
        assert_eq!(fresh.bytes_transferred, 5);
        assert!(
            fresh.remote_path.as_str().contains("note.")
                && fresh.remote_path.as_str().ends_with(".txt"),
            "{fresh:?}"
        );
        assert_eq!(
            fs::read(fresh.remote_path.as_str()).expect("the staged file"),
            b"hello"
        );

        let (report, _) = watch::channel(0u64);
        let again = connection
            .upload_file(source, report)
            .await
            .expect("the same file is met");

        assert_eq!(
            again.status,
            UploadStatus::SkippedDuplicate {
                existing_remote_path: fresh.remote_path.clone()
            }
        );
        assert_eq!(again.bytes_transferred, 0);
    }

    #[tokio::test]
    async fn a_local_upload_copies_a_file_of_this_machine() {
        let home = tempfile::tempdir().expect("a temporary home");
        let cache = tempfile::tempdir().expect("a temporary cache");
        let source = home.path().join("source.txt");
        fs::write(&source, b"bytes").expect("the source file");

        let (report, _) = watch::channel(0u64);
        let receipt = connection(&home, &cache)
            .upload_file(
                UploadSource::Local {
                    path: Utf8PathBuf::from_path_buf(source).expect("a UTF-8 path"),
                },
                report,
            )
            .await
            .expect("the file is staged");

        assert_eq!(receipt.total_bytes, 5);
        assert!(receipt.remote_path.as_str().contains("source."));
        assert!(!receipt.remote_path.as_str().contains('\\'));
    }

    #[tokio::test]
    async fn a_session_starts_only_in_an_absolute_directory_of_this_machine() {
        let home = tempfile::tempdir().expect("a temporary home");
        let cache = tempfile::tempdir().expect("a temporary cache");
        let connection = connection(&home, &cache);

        let error = match connection
            .spawn_pi(Utf8TypedPath::derive("relative"), None)
            .await
        {
            Ok(_) => panic!("a relative directory names no place"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("is not absolute"), "{error}");
    }
}
