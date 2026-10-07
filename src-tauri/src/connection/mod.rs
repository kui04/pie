//! The one host that pie talks to.
//!
//! Pi runs on the machine that has it: this machine, or a machine that pie
//! reaches over SSH. This module holds that relation. It reaches the host, it
//! starts the process that speaks the protocol, and it ends the process. It
//! stays free of Tauri. Therefore a test can use the full path against a real
//! host, with no UI in the way.
//!
//! The product keeps one host at a time. Therefore the app keeps one
//! [`Connection`]. The sessions on that host are the processes that pi runs: the
//! connect starts the first one, and everything else follows.
//!
//! The decision to trust a host is policy, and it lives with [`KnownHosts`]. The
//! app builds that policy for each connection and answers its questions.

mod error;
mod files;
mod host_key;

pub use error::Error;
pub use files::{DirEntryInfo, SessionSummary};
pub use host_key::{AskHostKey, KnownHosts, PresentedKey};

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh_sftp::client::SftpSession;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::PieError;
use crate::pi_rpc::Client;
use crate::pi_rpc::protocol::{Command, CommandKind, EntriesData, SessionState, SessionStats, SwitchSessionData};
use crate::pi_rpc::transport::{
    ExecOutput, HostKey, LocalTransport, RemoteCommand, SshAuth, SshSession, SshTarget, Termination,
};

/// The time for pi to stop before pie kills it.
///
/// Pi disposes its session when its stdin closes. Pie waits for that. A kill
/// leaves a half-written session file. Five seconds is longer than this step
/// needs, and short enough to look like an operation, not a hang.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// What the frontend asks pie to connect to.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum ConnectSpec {
    /// Pi on this machine, from `PATH`.
    Local,
    /// Pi on a host that pie reaches over SSH.
    Ssh {
        /// Hostname or address.
        host: String,
        /// The SSH port; 22 if the connect screen omits it.
        #[serde(default)]
        port: Option<u16>,
        /// Login name.
        user: String,
        /// How to authenticate.
        auth: SshAuthSpec,
    },
}

/// The credentials as the connect screen collected them.
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SshAuthSpec {
    /// A password.
    Password {
        /// The password itself.
        password: String,
    },
    /// A private key, as the text a key file holds.
    Key {
        /// The key itself. Pie never copies secret material into its own storage.
        key: String,
        /// The passphrase, if the key is encrypted.
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl std::fmt::Debug for SshAuthSpec {
    /// This function removes the secrets. This type arrives from the frontend
    /// and reaches the logs.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password { .. } => formatter.write_str("Password(<redacted>)"),
            Self::Key { key, passphrase } => formatter
                .debug_struct("Key")
                .field("bytes", &key.len())
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

impl From<SshAuthSpec> for SshAuth {
    fn from(spec: SshAuthSpec) -> Self {
        match spec {
            SshAuthSpec::Password { password } => Self::Password(password),
            SshAuthSpec::Key { key, passphrase } => Self::Key { key, passphrase },
        }
    }
}

/// What a connection needs from its app.
pub struct ConnectOptions {
    /// The home directory of this machine: the start of a local session if the
    /// frontend does not say. `None` leaves pi in the directory of the app. That
    /// is the result on a platform without a home directory.
    pub home: Option<PathBuf>,
    /// The host-key policy for the SSH handshake. The app builds one for each
    /// connection, because a host-key question names the connection of the
    /// question.
    pub host_key: Arc<dyn HostKey>,
    /// The number that the id of the session carries.
    ///
    /// The app keeps one count for the whole run of pie, and each connect takes
    /// the next number from it: `main:1` for the first session of the run,
    /// `main:2` for the next one, whether or not the connection is the same one.
    /// That keeps the events of a new pi off the channels of an old pi, whose
    /// frontend listeners may still be there.
    pub session_number: u64,
}

/// A host that pie is connected to.
#[derive(Debug)]
pub struct Connection {
    id: String,
    /// `local`, or `user@host:port`.
    endpoint: String,
    media: Media,
    sessions: Vec<Session>,
}

/// How pie reads the files of the host.
///
/// These are the two paths that the protocol knows, for the files of the host
/// and not for pi: the filesystem here, and sftp over the session of pi.
enum Media {
    /// This machine. The sessions of pi are ordinary files here.
    Local {
        /// The place where pi keeps the sessions. `None` if no home directory
        /// says.
        sessions_root: Option<PathBuf>,
        /// The home directory of this connection, and the answer to a directory
        /// listing without a path. The source is not the source of
        /// `sessions_root`: pi resolves its own root from its environment, and
        /// this is the home that the frontend gave for the directory of the
        /// session. The two are usually the same directory. They stay apart, so
        /// no rule of one guesses the other.
        home: Option<PathBuf>,
    },
    /// A host that pie reaches over SSH.
    Ssh {
        /// The one connection for all channels on this host.
        session: SshSession,
        /// The sftp channel. Pie opens it at the first use and opens it again
        /// after a failure (see [`files::sftp`], [`files::forget_sftp`]).
        sftp: Mutex<Option<Arc<SftpSession>>>,
    },
}

impl std::fmt::Debug for Media {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local { sessions_root, home } => formatter
                .debug_struct("Local")
                .field("sessions_root", sessions_root)
                .field("home", home)
                .finish(),
            Self::Ssh { session, sftp } => formatter
                .debug_struct("Ssh")
                .field("session", session)
                .field("sftp", &sftp.lock().map(|_| "<channel>"))
                .finish(),
        }
    }
}

impl Media {
    /// Closes the path itself: the SSH session and all channels on it. The local
    /// filesystem needs nothing.
    async fn close(&self) {
        if let Media::Ssh { session, .. } = self {
            session.close().await;
        }
    }
}

/// One `pi --mode rpc` process and the client that speaks to it.
#[derive(Debug)]
pub struct Session {
    id: String,
    /// The start of pi, if pie selected it. `None` means the directory of the
    /// login shell decided.
    cwd: Option<PathBuf>,
    client: Client,
}

/// What the frontend receives after a connection is ready.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    /// The name the frontend gave this connection.
    pub id: String,
    /// `local`, or `user@host:port`.
    pub endpoint: String,
    /// The sessions that operate on the host.
    pub sessions: Vec<SessionInfo>,
}

/// What the frontend receives about one session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// The id of this session, for the `pi://session/{id}/...` events.
    pub id: String,
    /// The start of pi, if pie selected it.
    pub cwd: Option<PathBuf>,
}

/// What the frontend hears about a connection during the handshake.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionState {
    /// A host presented a key that is in no store. Therefore the connection
    /// waits for a person. The result of an answer that never arrives is the
    /// business of the frontend: the frontend decides the length of the wait,
    /// and no answer is a refusal.
    HostKey {
        /// The key in the values that a person compares.
        key: PresentedKey,
    },
}

impl Connection {
    /// Reaches the host. Starts the first session of the host.
    ///
    /// An SSH connection can wait here for a person. Pie puts a host key that is
    /// in no store to the frontend. The answer arrives through a command while
    /// this call is pending.
    ///
    /// # Errors
    ///
    /// The failure of the reach to the host, as [`PieError`]. The reach of this
    /// side to a machine is [`Error`]. Every report of the protocol or of the
    /// transport below it keeps its own name as [`PieError::Rpc`]: no pi to run,
    /// a version that pie does not speak, a refused host key, or a failed
    /// handshake.
    pub async fn connect(
        id: impl Into<String>,
        spec: &ConnectSpec,
        options: &ConnectOptions,
    ) -> Result<Self, PieError> {
        let id = id.into();
        let (endpoint, cwd, client, media) = match spec {
            ConnectSpec::Local => {
                // A pi that is not the release of this build speaks a protocol
                // that pie does not know. Without the check, the mismatch looks
                // like a fault of pi, not like the wrong pi.
                crate::pi_rpc::check_version(crate::pi_rpc::probe_version("pi").await?)?;
                let mut transport = LocalTransport::pi();
                if let Some(home) = &options.home {
                    transport = transport.cwd(home);
                }
                (
                    LOCAL_ENDPOINT.to_string(),
                    options.home.clone(),
                    Client::start(transport.spawn()?)?,
                    Media::Local {
                        sessions_root: files::local_sessions_root(),
                        home: options.home.clone().or_else(dirs::home_dir),
                    },
                )
            }
            ConnectSpec::Ssh { host, port, user, auth } => {
                let mut target = SshTarget::new(host.clone(), user.clone());
                if let Some(port) = port {
                    target = target.port(*port);
                }
                let endpoint = target.endpoint();
                let session = SshSession::open(target, auth.clone().into(), Arc::clone(&options.host_key)).await?;
                // This is the same check as on the local path. One session
                // serves all channels on the host. Therefore the probe needs no
                // connection of its own.
                let probe = session.output("pi --version").await?;
                checked_remote_version(&endpoint, probe)?;
                // The first session starts in the directory of the login shell.
                // On SSH, work happens in the remote home until the user selects
                // a directory.
                let transport = session.exec(RemoteCommand::new("pi --mode rpc")).await?;
                (
                    endpoint,
                    None,
                    Client::start(transport)?,
                    Media::Ssh {
                        session,
                        sftp: Mutex::new(None),
                    },
                )
            }
        };

        tracing::info!(connection = %id, endpoint = %endpoint, "connected");
        Ok(Self {
            sessions: vec![Session {
                id: session_id(&id, options.session_number),
                cwd,
                client,
            }],
            id,
            endpoint,
            media,
        })
    }

    /// The name the frontend gave this connection.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// `local`, or `user@host:port`.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The sessions that operate on this host.
    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }

    /// The session with this id, if this connection has one.
    ///
    /// The id is the one that [`SessionInfo`] carries, which is pie's own id for
    /// the session. It is not the session id of pi, which is the id of the
    /// session file. The frontend reads this id from the answer of `connect`.
    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|session| session.id() == id)
    }

    /// Whether pi still operates behind a session.
    ///
    /// A connection does not end when its process dies. Nobody watches for that
    /// event yet. Therefore the app tells a live connection from a connection
    /// with a dead host here.
    pub fn is_alive(&self) -> bool {
        self.sessions.iter().any(|session| !session.client.is_closed())
    }

    /// What the frontend is told about this connection.
    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            id: self.id.clone(),
            endpoint: self.endpoint.clone(),
            sessions: self.sessions.iter().map(Session::info).collect(),
        }
    }

    /// Every session that pi wrote on this host, in all project directories.
    ///
    /// # Errors
    ///
    /// [`Error::UnreadableLocal`] if pie cannot read the sessions directory of
    /// this machine, and the failure of the reach to the host or of the read of
    /// the host for a remote listing. A path at fault names itself in the
    /// message.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, PieError> {
        match &self.media {
            Media::Local { sessions_root, .. } => match sessions_root {
                Some(root) => Ok(files::list_local(root).await?),
                None => Ok(Vec::new()),
            },
            Media::Ssh { session, sftp } => {
                let channel = files::sftp(session, sftp).await?;
                // A failed listing must not keep a dead channel in the cache
                // (files::forget_sftp).
                match files::list_remote(session, &channel).await {
                    Ok(summaries) => Ok(summaries),
                    Err(error) => {
                        files::forget_sftp(sftp, &channel);
                        Err(error.into())
                    }
                }
            }
        }
    }

    /// One directory level on the host, for the directory picker.
    ///
    /// `None` asks for the home directory: the directory of this machine here,
    /// or the login home over sftp. Any other value must be an absolute path on
    /// the host. Pie resolves nothing against its own directory, which on a
    /// phone is not the home of a person. The rows carry their full paths, so
    /// the picker never builds a path.
    ///
    /// # Errors
    ///
    /// [`Error::NotAbsolute`] for a relative path (a mistake of the frontend),
    /// and [`Error::UnreadableLocal`] or [`Error::UnreadableRemote`] if pie
    /// cannot read the path.
    pub async fn list_dirs(&self, path: Option<&str>) -> Result<Vec<DirEntryInfo>, PieError> {
        match &self.media {
            Media::Local { home, .. } => Ok(files::list_dirs_local(home.as_deref(), path).await?),
            Media::Ssh { session, sftp } => {
                // A relative path is a mistake of the frontend. The report of
                // that mistake does not need an sftp handshake.
                if let Some(path) = path
                    && !files::is_absolute_on_the_host(path)
                {
                    return Err(PieError::from(files::not_absolute(path)));
                }
                let channel = files::sftp(session, sftp).await?;
                match files::list_dirs_remote(&channel, path).await {
                    Ok(rows) => Ok(rows),
                    Err(error) => {
                        files::forget_sftp(sftp, &channel);
                        Err(error.into())
                    }
                }
            }
        }
    }

    /// Ends every session on this host. Closes the channel.
    ///
    /// The sessions stop. Their files stay where pi wrote them. Therefore a
    /// disconnect is different from a delete of a session. The method takes
    /// `&self` on purpose: the slot gives shared hands to this connection, and
    /// the file listings operate on them. The end of the connection must not
    /// need to own the last hand. The path closes here in all cases. Therefore a
    /// listing in progress meets a host that is already gone.
    pub async fn disconnect(&self) {
        for session in &self.sessions {
            if tokio::time::timeout(SHUTDOWN_GRACE, session.client.shutdown())
                .await
                .is_err()
            {
                tracing::warn!(session = %session.id, "pi did not exit in time; killing it");
                session.client.terminate().await;
            }
        }
        self.media.close().await;
        tracing::info!(connection = %self.id, "disconnected");
    }
}

/// Reads the version that `pi --version` printed on the host.
///
/// This is the same check as [`probe_version`](crate::pi_rpc::probe_version) and
/// [`check_version`](crate::pi_rpc::check_version) on this machine. This run
/// happened on the host. Therefore its failures name the endpoint, and the
/// output of a wrapped pi is the reason to pass on.
///
/// The failure of either module, because either event can occur here. A `pi`
/// that printed a version that pie does not speak is the failure of the protocol
/// layer. A probe with no answer is the failure of the reach of this side to the
/// machine.
fn checked_remote_version(endpoint: &str, output: ExecOutput) -> Result<(), PieError> {
    let printed = String::from_utf8_lossy(&output.stdout);
    let printed = printed.trim();
    if let Termination::Exited { success: true, .. } = output.termination
        && !printed.is_empty()
    {
        crate::pi_rpc::check_version(printed)?;
        return Ok(());
    }

    let said = String::from_utf8_lossy(&output.stderr);
    let said = said
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim();
    let said = said.chars().take(200).collect::<String>();
    let said = if said.is_empty() {
        String::new()
    } else {
        format!(", said `{said}`")
    };
    let ended = match output.termination {
        Termination::Exited { code, success: true } => format!("printed nothing on stdout (exit {code})"),
        Termination::Exited { code, .. } => format!("exited with {code}"),
        Termination::Signalled { signal } => format!("was killed by signal {signal}"),
        Termination::Unknown => "ended without a status".to_string(),
    };
    Err(PieError::from(Error::RemoteVersion {
        endpoint: endpoint.to_string(),
        reported: format!("{ended}{said}"),
    }))
}

/// The endpoint of a host that is this machine.
const LOCAL_ENDPOINT: &str = "local";

/// The id of the session that a connect starts.
///
/// The frontend subscribes to `pi://session/{id}/...` with this id, and it reads
/// it from the answer of the connect. The number makes it unique for the run of
/// pie: see [`ConnectOptions::session_number`].
///
/// The id must be usable in an event name. That is why the name of a connection
/// is checked before it arrives here, and why this function adds nothing but a
/// colon and digits to it: an event name may hold letters, digits, `-`, `_`, `:`
/// and `/` only, and a name outside that set is refused with
/// `tauri::Error::IllegalEventName`.
fn session_id(connection: &str, number: u64) -> String {
    format!("{connection}:{number}")
}

impl Session {
    /// The id of this session, for the `pi://session/{id}/...` events.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The start of pi, if pie selected it.
    pub fn cwd(&self) -> Option<&std::path::Path> {
        self.cwd.as_deref()
    }

    /// The client that speaks to the pi of this session.
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Sends one command and decodes the answer into its mirrored type.
    ///
    /// A read is a command whose answer is data, not an effect: pi answers the
    /// three of them from its own memory, and a failure here is the failure of
    /// the protocol. A write can also be refused by pi itself, and it arrives
    /// here the same way — [`Response::into_result`] turns a refusal into
    /// `Error::Rpc` with pi's own message.
    ///
    /// [`Response::into_result`]: crate::pi_rpc::protocol::Response::into_result
    async fn ask<T: DeserializeOwned>(&self, command: Command) -> Result<T, PieError> {
        Ok(self.client.request(command).await?.into_result()?.decode::<T>()?)
    }

    /// The state of this session: its model, its run, its name, its counts.
    ///
    /// Pi builds this answer from memory. It does not wait for the run in
    /// progress. Therefore this read is safe while a turn streams.
    ///
    /// # Errors
    ///
    /// The failure of the protocol: pi refuses the command, the payload has a
    /// shape this mirror does not know, or the pi of this session is gone.
    pub async fn state(&self) -> Result<SessionState, PieError> {
        self.ask(Command::new(CommandKind::GetState)).await
    }

    /// Every entry of this session, and the leaf the session points at.
    ///
    /// The answer is the raw set. It holds the entries of the other branches of
    /// a fork, and it keeps the entries that a compaction summarized. The view
    /// of the transcript - the path from the root to the leaf, with the
    /// compactions folded - is the task of the frontend.
    ///
    /// # Errors
    ///
    /// The same as [`Session::state`].
    pub async fn entries(&self) -> Result<EntriesData, PieError> {
        self.ask(Command::new(CommandKind::GetEntries { since: None })).await
    }

    /// The usage of this session: its counts, its tokens, its cost.
    ///
    /// # Errors
    ///
    /// The same as [`Session::state`].
    pub async fn stats(&self) -> Result<SessionStats, PieError> {
        self.ask(Command::new(CommandKind::GetSessionStats)).await
    }

    /// Makes this session continue the conversation in another session file.
    ///
    /// The process stays where it is; the conversation it holds does not. Pi
    /// opens the file, takes its leaf as the point to continue from, and
    /// re-binds the extensions to the new session (the `switch_session` arm of
    /// `rpc-mode.ts`, pinned). Its answer carries one fact: `cancelled` says
    /// that an extension's `before_switch` hook refused the switch, and then
    /// this session is the one it was.
    ///
    /// Nothing in the answer describes the new transcript, and no event
    /// announces the change: the caller reads it again with
    /// [`Session::entries`].
    ///
    /// A path that holds no session file is opened rather than refused (pi
    /// reads a header only when the file is there). Therefore the caller hands
    /// out the paths of [`Connection::list_sessions`] and builds none: pi would
    /// continue in its own directory and write a new conversation there.
    ///
    /// The path must be absolute, as the paths of that listing are. A relative one
    /// is a mistake: pi would resolve it against its own directory, which on a phone
    /// is not the home of a person.
    ///
    /// # Errors
    ///
    /// [`Error::NotAbsolute`] for a relative path, and the failure of the protocol —
    /// including a refusal of pi itself: neither a session file whose working
    /// directory is gone nor a file of the host that is not a session is one pi
    /// opens.
    pub async fn switch_session(&self, session_path: &str) -> Result<SwitchSessionData, PieError> {
        let path = files::checked_session_path(session_path)?;
        self.ask(Command::new(CommandKind::SwitchSession {
            session_path: path.to_string(),
        }))
        .await
    }

    /// What the frontend is told about this session.
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_named_after_its_connection_and_its_number() {
        assert_eq!(session_id("main", 1), "main:1");
        assert_eq!(
            session_id("main", 2),
            "main:2",
            "the second pi of a connection does not take the id of the first"
        );
    }

    #[test]
    fn the_id_of_a_session_is_usable_in_an_event_name() {
        // The frontend subscribes to `pi://session/{id}/...`, and Tauri refuses
        // an event name that holds a character outside letters, digits, `-`,
        // `_`, `:` and `/` (`tauri::event::event_name`). The name of a connection
        // is checked before it arrives here; this holds that the id that is
        // built from it stays inside that set too.
        for number in [0, 1, 42, u64::MAX] {
            let id = session_id("conn-1_b", number);
            assert!(
                id.chars().all(|c| c.is_ascii_alphanumeric() || "_-:".contains(c)),
                "`{id}` must survive as the name of an event"
            );
        }
    }

    #[test]
    fn credentials_never_reach_a_log() {
        let password = SshAuthSpec::Password {
            password: "hunter2".to_string(),
        };
        let key = SshAuthSpec::Key {
            key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----".to_string(),
            passphrase: Some("letmein".to_string()),
        };

        for (spec, secret) in [(password, "hunter2"), (key, "letmein")] {
            let rendered = format!("{spec:?}");
            assert!(!rendered.contains(secret), "got `{rendered}`");
            assert!(!rendered.contains("AAAA"), "the key itself reached a log: `{rendered}`");
            assert!(rendered.contains("<redacted>"), "got `{rendered}`");
        }
    }

    #[test]
    fn a_spec_without_a_key_passphrase_is_still_a_key() {
        let spec: ConnectSpec = serde_json::from_str(
            r#"{"transport":"ssh","host":"example.com","user":"pi","auth":{"type":"key","key":"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"}}"#,
        )
        .expect("the connect screen may leave the passphrase out");
        match spec {
            ConnectSpec::Ssh { port, auth, .. } => {
                assert_eq!(port, None);
                assert!(matches!(auth, SshAuthSpec::Key { passphrase: None, .. }));
            }
            other => panic!("unexpected spec: {other:?}"),
        }
    }

    #[test]
    fn a_host_probe_with_the_pin_passes_and_a_foreign_one_does_not() {
        let printed = |stdout: &[u8]| ExecOutput {
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
            termination: Termination::Exited { code: 0, success: true },
        };

        checked_remote_version("pi@host:22", printed(crate::pi_rpc::PI_VERSION.as_bytes())).expect("the pin matches");

        match checked_remote_version("pi@host:22", printed(b"0.84.2")).unwrap_err() {
            PieError::Rpc { error: box_error, .. } => match *box_error {
                crate::pi_rpc::Error::VersionMismatch { found, .. } => assert_eq!(found, "0.84.2"),
                ref other => panic!("unexpected error: {other:?}"),
            },
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn a_host_probe_that_cannot_answer_names_the_endpoint_and_why() {
        let output = ExecOutput {
            stdout: Vec::new(),
            stderr: b"pi: command not found\n".to_vec(),
            termination: Termination::Exited {
                code: 127,
                success: false,
            },
        };

        match checked_remote_version("pi@host:22", output).unwrap_err() {
            PieError::Connection { error, .. } => match *error {
                Error::RemoteVersion { endpoint, reported } => {
                    assert_eq!(endpoint, "pi@host:22");
                    assert!(reported.contains("exited with 127"), "got `{reported}`");
                    assert!(reported.contains("command not found"), "got `{reported}`");
                }
                ref other => panic!("unexpected error: {other:?}"),
            },
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
