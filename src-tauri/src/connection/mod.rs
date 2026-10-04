//! The one host pie talks to.
//!
//! Pi runs on the machine that has it: this one, or one reached over SSH. This
//! module holds that relationship - it reaches the host, starts the process
//! that speaks the protocol, and ends it - and it stays free of Tauri, so the
//! whole path can be tested against a real host with no UI in the way.
//!
//! One host at a time is what the product needs, so the app keeps one
//! [`Connection`]. Sessions on that host are the processes pi runs:
//! connecting starts the first one, and everything else follows from there.
//!
//! Deciding whether to trust a host is policy and lives with [`KnownHosts`];
//! the app builds that policy per connection and answers its questions.

mod files;
mod host_key;

pub use files::{DirEntryInfo, SessionSummary};
pub use host_key::{AskHostKey, KnownHosts, PresentedKey};

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};

use crate::error::PieError;
use crate::pi_rpc::Client;
use crate::pi_rpc::transport::{
    ExecOutput, HostKey, LocalTransport, RemoteCommand, SshAuth, SshSession, SshTarget, Termination,
};

/// How long pi gets to shut down before it is killed.
///
/// Pi disposes its session when its stdin closes, which is worth waiting for -
/// killing it leaves whatever it was writing half-written. Five seconds is
/// longer than that takes and short enough not to look like a hang.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// What the frontend asks pie to connect to.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum ConnectSpec {
    /// Pi on this machine, taken from `PATH`.
    Local,
    /// Pi on a host reached over SSH.
    Ssh {
        /// Hostname or address.
        host: String,
        /// SSH port; 22 when the connect screen leaves it out.
        #[serde(default)]
        port: Option<u16>,
        /// Login name.
        user: String,
        /// How to authenticate.
        auth: SshAuthSpec,
    },
}

/// Credentials as the connect screen collected them.
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
        /// The key itself: pie never copies secret material into its own storage.
        key: String,
        /// Passphrase, when the key is encrypted.
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl std::fmt::Debug for SshAuthSpec {
    /// Redacts secrets: this type arrives from the frontend and reaches logs.
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

/// What a connection needs from the app it serves.
pub struct ConnectOptions {
    /// This machine's home directory: where a local session starts when the
    /// frontend does not say. `None` leaves pi in whatever directory the app
    /// was started in, which is what happens on platforms without one.
    pub home: Option<PathBuf>,
    /// The host-key policy the SSH handshake asks. Built per connection by the
    /// app, because a question about a host key names the connection it belongs
    /// to.
    pub host_key: Arc<dyn HostKey>,
}

/// A host pie is connected to.
#[derive(Debug)]
pub struct Connection {
    id: String,
    /// `local`, or `user@host:port`.
    endpoint: String,
    media: Media,
    sessions: Vec<Session>,
}

/// How pie reads the host's files.
///
/// The two reaches the protocol knows, for the host's own files rather than
/// for pi: the filesystem here, sftp over the very session pi runs on.
enum Media {
    /// This machine: pi's sessions are ordinary files here.
    Local {
        /// Where pi keeps them; nothing when no home says.
        sessions_root: Option<PathBuf>,
        /// The home this connection was told about, what a directory listing
        /// with no path asks for. Not the same source as `sessions_root`: pi
        /// resolves its own from the environment it is started with, while
        /// this is the home the frontend named for the session's directory -
        /// normally the same directory, and kept apart so neither is guessed
        /// at from the other's rule.
        home: Option<PathBuf>,
    },
    /// A host reached over SSH.
    Ssh {
        /// The one connection every channel on this host rides on.
        session: SshSession,
        /// The sftp channel, opened on first use and reopened when it has died
        /// (see [`files::sftp`], [`files::forget_sftp`]).
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
    /// Closes the reach itself - the SSH session and, with it, every channel
    /// on it. The local filesystem needs nothing.
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
    /// Where pi started, when pie chose that. `None` means the login shell's own
    /// directory decided it.
    cwd: Option<PathBuf>,
    client: Client,
}

/// What the frontend gets back once a connection is up.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    /// The name the frontend gave this connection.
    pub id: String,
    /// `local`, or `user@host:port`.
    pub endpoint: String,
    /// The sessions running on the host.
    pub sessions: Vec<SessionInfo>,
}

/// What the frontend gets back about one session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Name of this session, for the `pi://session/{id}/...` events.
    pub id: String,
    /// Where pi started, when pie chose that.
    pub cwd: Option<PathBuf>,
}

/// What the frontend hears about a connection while it is being made.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionState {
    /// A host presented a key that is in no store, so the connection is waiting
    /// for a person. What `connect` does with an answer that never comes is the
    /// frontend's business: it decides how long to wait, and no answer is a
    /// refusal.
    HostKey {
        /// The key in the terms a person checks it in.
        key: PresentedKey,
    },
}

impl Connection {
    /// Reaches the host and starts its first session.
    ///
    /// An SSH connection may wait here for a person: a host key that is in no
    /// store is put to the frontend, and the answer arrives through a command
    /// while this call is pending.
    ///
    /// # Errors
    ///
    /// Whatever the transport reports, as [`PieError`]: nothing on this machine
    /// to run ([`PieError::Process`], which also covers a `pi` that is not the
    /// release pie speaks), or the SSH failures of
    /// [`SshSession::open`](crate::pi_rpc::transport::SshSession::open).
    pub async fn connect(
        id: impl Into<String>,
        spec: &ConnectSpec,
        options: &ConnectOptions,
    ) -> Result<Self, PieError> {
        let id = id.into();
        let (endpoint, cwd, client, media) = match spec {
            ConnectSpec::Local => {
                // A pi that is not the release this build mirrors speaks a
                // protocol pie does not know, and the mismatch would look like
                // pi misbehaving rather than like the wrong pi.
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
                // The same check the local path makes: one session serves
                // every channel on the host, so the probe no longer costs a
                // connection of its own.
                let probe = session.output("pi --version").await?;
                checked_remote_version(&endpoint, probe)?;
                // The first session starts where the login shell does: on SSH
                // the remote home is where work happens until the user picks a
                // directory.
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
                id: format!("{id}:1"),
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

    /// The sessions running on this host.
    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }

    /// Whether pi is still running behind any of the sessions.
    ///
    /// A connection is not ended when its process dies - nobody is watching for
    /// that yet - so this is how the app tells a live connection from one whose
    /// host is gone.
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

    /// Every session pi has written on this host, across project directories.
    ///
    /// # Errors
    ///
    /// [`PieError::Transport`] when the host's sessions directory cannot be
    /// read - a path at fault names itself in the message.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, PieError> {
        match &self.media {
            Media::Local { sessions_root, .. } => match sessions_root {
                Some(root) => files::list_local(root).await,
                None => Ok(Vec::new()),
            },
            Media::Ssh { session, sftp } => {
                let channel = files::sftp(session, sftp).await?;
                // A failed listing over a channel that had died must not leave
                // the dead one cached (files::forget_sftp).
                match files::list_remote(session, &channel).await {
                    Ok(summaries) => Ok(summaries),
                    Err(error) => {
                        files::forget_sftp(sftp, &channel);
                        Err(error)
                    }
                }
            }
        }
    }

    /// One directory level on the host, for the directory picker.
    ///
    /// `None` asks for the home directory - this machine's here, the login
    /// home over sftp. Anything else must be an absolute path on the host: pie
    /// resolves nothing against its own directory, which on a phone is not
    /// anyone's home, and the rows carry their whole paths so the picker never
    /// builds one of its own.
    ///
    /// # Errors
    ///
    /// [`PieError::Internal`] for a relative path (the frontend's mistake),
    /// [`PieError::Transport`] when the path cannot be read.
    pub async fn list_dirs(&self, path: Option<&str>) -> Result<Vec<DirEntryInfo>, PieError> {
        match &self.media {
            Media::Local { home, .. } => files::list_dirs_local(home.as_deref(), path).await,
            Media::Ssh { session, sftp } => {
                // A relative path is the frontend's mistake, and saying so is
                // not worth an sftp handshake first.
                if let Some(path) = path
                    && !files::is_absolute_on_the_host(path)
                {
                    return Err(files::not_absolute(path));
                }
                let channel = files::sftp(session, sftp).await?;
                match files::list_dirs_remote(&channel, path).await {
                    Ok(rows) => Ok(rows),
                    Err(error) => {
                        files::forget_sftp(sftp, &channel);
                        Err(error)
                    }
                }
            }
        }
    }

    /// Ends every session on this host and closes the channel.
    ///
    /// Sessions stop; their files stay where pi wrote them, which is what makes
    /// disconnecting different from deleting a session. Takes `&self` on
    /// purpose: the slot hands out shared hands to this connection (the file
    /// listings run on them), and ending it must not need to own the last one.
    /// The reach itself closes here regardless, so a listing still in flight
    /// meets a host that is already gone rather than keeping it alive.
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

/// Reads the version the host's `pi --version` printed.
///
/// The same check [`probe_version`](crate::pi_rpc::probe_version) and
/// [`check_version`](crate::pi_rpc::check_version) do on this machine; this run
/// happened on the host, so its failures name the endpoint, and what a wrapped
/// pi printed about itself is the reason worth passing on.
fn checked_remote_version(endpoint: &str, output: ExecOutput) -> Result<(), PieError> {
    let printed = String::from_utf8_lossy(&output.stdout);
    let printed = printed.trim();
    if let Termination::Exited { success: true, .. } = output.termination
        && !printed.is_empty()
    {
        return crate::pi_rpc::check_version(printed).map_err(PieError::from);
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
    Err(PieError::Process {
        message: format!("`pi --version` on {endpoint} {ended}{said}"),
    })
}

/// Endpoint of a host that is this machine.
const LOCAL_ENDPOINT: &str = "local";

impl Session {
    /// Name of this session, for the `pi://session/{id}/...` events.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Where pi started, when pie chose that.
    pub fn cwd(&self) -> Option<&std::path::Path> {
        self.cwd.as_deref()
    }

    /// The client that speaks to this session's pi.
    pub fn client(&self) -> &Client {
        &self.client
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
            PieError::Process { message } => assert!(message.contains("0.84.2"), "got `{message}`"),
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
            PieError::Process { message } => {
                assert!(message.contains("pi@host:22"), "got `{message}`");
                assert!(message.contains("exited with 127"), "got `{message}`");
                assert!(message.contains("command not found"), "got `{message}`");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
