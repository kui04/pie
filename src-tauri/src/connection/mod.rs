//! The one host pie talks to.
//!
//! Pi runs on the machine that has it: this one, or one reached over SSH. This
//! module holds that relationship - it reaches the host, starts the process
//! that speaks the protocol, and ends it - and it stays free of Tauri, so the
//! whole path can be tested against a real host with no UI in the way.
//!
//! One host at a time is what the product needs (docs/TODO.md, G12), so the app
//! keeps one [`Connection`]. Sessions on that host are the processes pi runs:
//! connecting starts the first one, and everything else follows from there.
//!
//! Deciding whether to trust a host is policy and lives with [`KnownHosts`];
//! the app builds that policy per connection and answers its questions.

mod host_key;

pub use host_key::{AskHostKey, KnownHosts, PresentedKey};

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::PieError;
use crate::pi_rpc::Client;
use crate::pi_rpc::transport::{HostKey, LocalTransport, SshAuth, SshTarget, SshTransport};

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
    /// A private key, which pie reads where it lies.
    Key {
        /// Path of the private key file.
        path: PathBuf,
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
            Self::Key { path, passphrase } => formatter
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

impl From<SshAuthSpec> for SshAuth {
    fn from(spec: SshAuthSpec) -> Self {
        match spec {
            SshAuthSpec::Password { password } => Self::Password(password),
            SshAuthSpec::Key { path, passphrase } => Self::Key { path, passphrase },
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
    sessions: Vec<Session>,
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
    /// [`SshTransport::open`](crate::pi_rpc::transport::SshTransport::open).
    pub async fn connect(
        id: impl Into<String>,
        spec: &ConnectSpec,
        options: &ConnectOptions,
    ) -> Result<Self, PieError> {
        let id = id.into();
        let (endpoint, cwd, client) = match spec {
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
                )
            }
            ConnectSpec::Ssh { host, port, user, auth } => {
                let mut target = SshTarget::new(host.clone(), user.clone());
                if let Some(port) = port {
                    target = target.port(*port);
                }
                let endpoint = target.endpoint();
                let transport = SshTransport::open(target, auth.clone().into(), Arc::clone(&options.host_key)).await?;
                // The remote `pi --version` is not probed: that would cost a
                // second channel, which pie's SSH transport does not hand out
                // yet (docs/TODO.md, G16).
                (endpoint, None, Client::start(transport)?)
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

    /// Ends every session on this host and closes the channel.
    ///
    /// Sessions stop; their files stay where pi wrote them, which is what makes
    /// disconnecting different from deleting a session.
    pub async fn disconnect(self) {
        for session in self.sessions {
            if tokio::time::timeout(SHUTDOWN_GRACE, session.client.shutdown())
                .await
                .is_err()
            {
                tracing::warn!(session = %session.id, "pi did not exit in time; killing it");
                session.client.terminate().await;
            }
        }
        tracing::info!(connection = %self.id, "disconnected");
    }
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
            path: PathBuf::from("/home/pi/.ssh/id_ed25519"),
            passphrase: Some("letmein".to_string()),
        };

        for (spec, secret) in [(password, "hunter2"), (key, "letmein")] {
            let rendered = format!("{spec:?}");
            assert!(!rendered.contains(secret), "got `{rendered}`");
            assert!(rendered.contains("<redacted>"), "got `{rendered}`");
        }
    }

    #[test]
    fn a_spec_without_a_key_passphrase_is_still_a_key() {
        let spec: ConnectSpec = serde_json::from_str(
            r#"{"transport":"ssh","host":"example.com","user":"pi","auth":{"type":"key","path":"/k"}}"#,
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
}
