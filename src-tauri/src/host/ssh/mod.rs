//! The reach to a machine over SSH, and the machine it holds.
//!
//! [`SshTarget`] is where to go and [`SshAuth`] is how to prove it is pie. The
//! reach itself - the socket, the handshake, the host-key question, the
//! credentials, the channels and what they hand back - is [`SshSession`], in the
//! [`session`] module. One command as the remote shell runs it is
//! [`RemoteCommand`], in [`command`].
//!
//! The key a host presents is the one question pie cannot answer from the wire:
//! [`HostKey`] is where the reach asks it, [`AskHostKey`] is where the policy
//! asks a person, and [`KnownHosts`] is the policy pie ships - in [`trust`] and
//! [`known_hosts`], because a host key of any other kind does not exist here.
//!
//! [`SshHost`] is the machine that is left once the reach succeeded: one
//! connection, and the file channel that is opened on it at the first read. It is
//! the SSH flavour of [`Host`](super::Host), which is what the rest of the crate
//! holds.
//!
//! ```no_run
//! use pie_lib::host::{SshAuth, SshSession, SshTarget, Trust};
//!
//! # async fn example() -> pie_lib::host::Result<()> {
//! struct Always; // an app's policy, told what the host presented
//!
//! impl pie_lib::host::HostKey for Always {
//!     fn verify(
//!         &self,
//!         _host: &str,
//!         _port: u16,
//!         key: &russh::keys::PublicKeyOrCertificate,
//!     ) -> std::pin::Pin<Box<dyn std::future::Future<Output = pie_lib::host::Result<()>> + Send + '_>> {
//!         let certified = key.certificate().is_some();
//!         Box::pin(async move {
//!             println!("certified: {certified}");
//!             Ok(())
//!         })
//!     }
//! }
//!
//! let session = SshSession::open(
//!     SshTarget::new("example.com", "pi"),
//!     SshAuth::Password("hunter2".to_string()),
//!     Trust::new(Always),
//! )
//! .await?;
//! // pi runs in an exec channel; the very same session also answers for files.
//! let exec = session.exec("pi --mode rpc").await?;
//! let sftp = session.subsystem("sftp").await?;
//! # let _ = (exec, sftp);
//! # Ok(())
//! # }
//! ```

mod command;
mod known_hosts;
mod session;
mod trust;

pub use command::RemoteCommand;
pub(crate) use command::quote;
pub use known_hosts::KnownHosts;
pub use session::{ExecOutput, SshSession, SubsystemStream};
pub use trust::{AskHostKey, HostKey, PresentedKey, Trust};

use std::sync::{Arc, Mutex, PoisonError};

use russh_sftp::client::SftpSession;

use super::files;
use super::spec::Auth;

use super::Endpoint;

/// How to identify at the SSH server.
#[derive(Clone)]
pub enum SshAuth {
    /// Password authentication.
    Password(String),
    /// Public-key authentication with the private key itself.
    ///
    /// The key, not a path to it. `load_secret_key` was a file read followed by
    /// the same decode this does, and on Android a picked file is a `content://`
    /// URI rather than a path at all - so the text is what crosses the boundary,
    /// and the frontend is what turns a file into text.
    Key {
        /// The private key, in the OpenSSH or PEM form a key file holds.
        key: String,
        /// Passphrase, when the key is encrypted.
        passphrase: Option<String>,
    },
}

impl std::fmt::Debug for SshAuth {
    /// Redacts secrets: this type reaches logs and error reports.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password(_) => formatter.write_str("Password(<redacted>)"),
            Self::Key { key, passphrase } => formatter
                .debug_struct("Key")
                .field("bytes", &key.len())
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

impl From<Auth> for SshAuth {
    fn from(auth: Auth) -> Self {
        match auth {
            Auth::Password { password } => Self::Password(password),
            Auth::Key { key, passphrase } => Self::Key { key, passphrase },
        }
    }
}

/// The host to reach.
#[derive(Debug, Clone)]
pub struct SshTarget {
    host: String,
    port: u16,
    user: String,
}

impl SshTarget {
    /// Targets `host` as `user` on port 22.
    pub fn new(host: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            port: 22,
            user: user.into(),
        }
    }

    /// Uses another port.
    pub fn port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// `user@host:port`, the label of this host for a person and for a log line.
    pub fn endpoint(&self) -> Endpoint {
        Endpoint::new(format!("{}@{}:{}", self.user, self.host, self.port))
    }
}
/// A machine pie reaches over SSH: the session, and the file channel over it.
///
/// The file channel is opened at the first use and kept for the rest of the
/// connection; a read that finds it dead drops it, and the next read opens a
/// fresh one. Both belong to the session because an SSH connection is one object
/// with many channels on it.
pub struct SshHost {
    session: SshSession,
    sftp: Mutex<Option<Arc<SftpSession>>>,
}

impl std::fmt::Debug for SshHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshHost")
            .field("session", &self.session)
            .finish()
    }
}

impl SshHost {
    /// Wraps a session that is already authenticated.
    pub(crate) fn new(session: SshSession) -> Self {
        Self {
            session,
            sftp: Mutex::new(None),
        }
    }

    /// The label of this host, `user@host:port`.
    pub fn endpoint(&self) -> &Endpoint {
        self.session.endpoint()
    }

    /// The session that serves every channel on this host.
    pub(crate) fn session(&self) -> &SshSession {
        &self.session
    }

    /// The file channel that is already open, if one is.
    pub(crate) fn cached_sftp(&self) -> Option<Arc<SftpSession>> {
        self.sftp.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Keeps an open file channel for the reads that follow.
    pub(crate) fn keep_sftp(&self, opened: &Arc<SftpSession>) {
        *self.sftp.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(opened));
    }

    /// Drops the file channel if it is still the one a failed read used.
    pub(crate) fn forget_sftp(&self, used: &Arc<SftpSession>) {
        let mut slot = self.sftp.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().is_some_and(|cached| Arc::ptr_eq(cached, used)) {
            *slot = None;
        }
    }

    /// Runs one read on the file channel of this host, and opens it first when it
    /// is not open.
    ///
    /// A read that fails drops the channel: a channel that answered with a
    /// failure of its own is not one to keep for the next read.
    pub(crate) async fn with_sftp<T, F>(&self, read: F) -> super::Result<T>
    where
        F: std::ops::AsyncFnOnce(&SftpSession) -> super::Result<T>,
    {
        let opened = files::sftp(self).await?;
        match read(&*opened).await {
            Ok(value) => Ok(value),
            Err(error) => {
                self.forget_sftp(&opened);
                Err(error)
            }
        }
    }

    /// Drops the file channel whatever it is, for a session that is going away.
    pub(crate) fn clear_sftp(&self) {
        *self.sftp.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Ends the session and everything on it.
    pub(crate) async fn close(&self) {
        self.session.close().await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_names_the_user_host_and_port() {
        assert_eq!(
            SshTarget::new("example.com", "pi").endpoint().to_string(),
            "pi@example.com:22"
        );
        assert_eq!(
            SshTarget::new("example.com", "pi").port(2222).endpoint().to_string(),
            "pi@example.com:2222"
        );
    }

    #[test]
    fn auth_debug_output_never_prints_secrets() {
        let password = format!("{:?}", SshAuth::Password("hunter2".to_string()));
        assert_eq!(password, "Password(<redacted>)");

        let key = format!(
            "{:?}",
            SshAuth::Key {
                key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----".to_string(),
                passphrase: Some("hunter2".to_string()),
            }
        );
        // The key has no path to name any more, so what must not appear is the
        // key itself: only its size.
        assert!(!key.contains("BEGIN OPENSSH PRIVATE KEY"), "got `{key}`");
        assert!(!key.contains("AAAA"), "got `{key}`");
        assert!(!key.contains("hunter2"), "got `{key}`");
        assert!(key.contains("<redacted>"), "got `{key}`");
    }

    #[test]
    fn the_credentials_of_the_connect_screen_become_the_handshakes() {
        let password = SshAuth::from(Auth::Password {
            password: "hunter2".to_string(),
        });
        assert!(matches!(password, SshAuth::Password(ref secret) if secret == "hunter2"));

        let key = SshAuth::from(Auth::Key {
            key: "k".to_string(),
            passphrase: Some("p".to_string()),
        });
        assert!(matches!(key, SshAuth::Key { ref key, passphrase: Some(ref p) } if key == "k" && p == "p"));
    }
}
