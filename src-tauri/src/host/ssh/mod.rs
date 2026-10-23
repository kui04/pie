//! The reach to a machine over SSH, and the machine it holds.
//!
//! [`SshTarget`] is where to go and [`SshAuth`] is how to prove it is pie. The
//! reach itself - the socket, the handshake, the host-key question, the
//! credentials, the channels and what they hand back - is [`SshSession`], in the
//! [`session`] module. The shell line of one command is composed in this module.
//!
//! The key a host presents is the one question pie cannot answer from the wire:
//! [`HostKey`] is where the reach asks it, [`AskHostKey`] is where the policy
//! asks a person, and [`KnownHosts`] is the policy pie ships - in [`trust`] and
//! [`known_hosts`], because a host key of any other kind does not exist here.
//!
//! [`SshHost`] is the machine that is left once the reach succeeded: one
//! connection, and the file channel that is opened on it at the first read. It is
//! the SSH implementation of [`Connection`], [`Files`], and [`Exec`].
//!
mod files;
mod known_hosts;
mod quote;
mod session;
mod trust;

pub use known_hosts::KnownHosts;
use quote::quote;
pub use session::{SshSession, SubsystemStream};
pub use trust::{AskHostKey, HostKey, PresentedKey, Trust};

use std::sync::{Arc, Mutex, PoisonError};

use russh_sftp::client::SftpSession;

use crate::channel::Channel;

use super::{
    AsyncReadSeek, CommandSpec, Connection, Endpoint, Exec, ExecOutput, FileEntry, Files, ProgressFn, StageSource,
    files as host_files, is_posix_absolute,
};

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

/// The open SSH session and the lazy SFTP channel bound to it.
struct Connected {
    session: Arc<SshSession>,
    sftp: Option<Arc<SftpSession>>,
}

/// A machine pie reaches over SSH: the target, credentials, trust policy, live
/// session, and the file channel over it.
///
/// The file channel is opened at the first use and kept for the rest of the
/// connection; a read that finds it dead drops it, and the next read opens a
/// fresh one. Both belong to the session because an SSH connection is one object
/// with many channels on it.
pub struct SshHost {
    target: SshTarget,
    auth: SshAuth,
    trust: Trust,
    state: Mutex<Option<Connected>>,
}

impl std::fmt::Debug for SshHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshHost")
            .field("target", &self.target)
            .field("auth", &self.auth)
            .field("trust", &self.trust)
            .finish_non_exhaustive()
    }
}

impl SshHost {
    /// Creates an SSH host configured with `target`, `auth`, and `trust`.
    ///
    /// Call [`Host::connect`](super::Host::connect) to open the SSH connection
    /// and verify `pi`.
    pub fn new(target: SshTarget, auth: SshAuth, trust: Trust) -> Self {
        Self {
            target,
            auth,
            trust,
            state: Mutex::new(None),
        }
    }

    /// The label of this host, `user@host:port`.
    pub fn endpoint(&self) -> Endpoint {
        self.target.endpoint()
    }

    /// The active SSH session, or an error if the host is not connected.
    pub(super) fn active_session(&self) -> anyhow::Result<Arc<SshSession>> {
        self.current_session()
            .ok_or_else(|| anyhow::anyhow!("the SSH session to {} is not open", self.target.endpoint()))
    }

    fn current_session(&self) -> Option<Arc<SshSession>> {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|connected| Arc::clone(&connected.session))
    }

    /// The file channel that is already open on `for_session`, if one is.
    pub(super) fn cached_sftp(&self, for_session: &Arc<SshSession>) -> Option<Arc<SftpSession>> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let connected = state.as_ref()?;
        Arc::ptr_eq(&connected.session, for_session)
            .then(|| connected.sftp.as_ref().cloned())
            .flatten()
    }

    /// Keeps an open file channel for `for_session` if that session is still current.
    pub(super) fn keep_sftp(&self, for_session: &Arc<SshSession>, opened: &Arc<SftpSession>) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(connected) = state.as_mut()
            && Arc::ptr_eq(&connected.session, for_session)
        {
            connected.sftp = Some(Arc::clone(opened));
        }
    }

    /// Drops the file channel if it is still the one a failed read used.
    pub(super) fn forget_sftp(&self, used: &Arc<SftpSession>) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(connected) = state.as_mut()
            && connected.sftp.as_ref().is_some_and(|cached| Arc::ptr_eq(cached, used))
        {
            connected.sftp = None;
        }
    }

    /// Runs one operation on the file channel of this host, and opens it first
    /// when it is not open.
    ///
    /// An operation that fails drops the channel: a channel that answered with a
    /// failure of its own is not one to keep for the next operation.
    pub(super) async fn with_sftp<T, F>(&self, op: F) -> anyhow::Result<T>
    where
        F: std::ops::AsyncFnOnce(&SftpSession) -> anyhow::Result<T>,
    {
        let opened = files::sftp(self).await?;
        match op(&*opened).await {
            Ok(value) => Ok(value),
            Err(error) => {
                self.forget_sftp(&opened);
                Err(error)
            }
        }
    }
}

#[async_trait::async_trait]
impl Connection for SshHost {
    async fn connect(&self) -> anyhow::Result<()> {
        let session = SshSession::open(self.target.clone(), self.auth.clone(), self.trust.clone()).await?;

        let previous = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(Connected {
                session: Arc::new(session),
                sftp: None,
            });
        if let Some(previous) = previous {
            previous.session.close().await;
        }
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.current_session().is_some_and(|session| session.is_open())
    }

    fn endpoint(&self) -> Endpoint {
        self.target.endpoint()
    }

    async fn close(&self) {
        let previous = self.state.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(previous) = previous {
            previous.session.close().await;
            tracing::info!(endpoint = %self.endpoint(), "disconnected");
        }
    }
}

#[async_trait::async_trait]
impl Exec for SshHost {
    async fn spawn(&self, command: CommandSpec) -> anyhow::Result<Channel> {
        if let Some(dir) = &command.current_dir {
            is_posix_absolute(dir)?;
        }
        let line = command_line(&command);
        let session = self.active_session()?;
        Ok(session.exec(line).await?.into_channel())
    }

    async fn output(&self, command: CommandSpec) -> anyhow::Result<ExecOutput> {
        if let Some(dir) = &command.current_dir {
            is_posix_absolute(dir)?;
        }
        let line = command_line(&command);
        let session = self.active_session()?;
        session.output(line).await
    }
}

#[async_trait::async_trait]
impl Files for SshHost {
    async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
        is_posix_absolute(path)?;
        self.with_sftp(async |sftp| files::is_dir(sftp, path).await).await
    }

    async fn create_dir_all(&self, path: &str) -> anyhow::Result<()> {
        is_posix_absolute(path)?;
        self.with_sftp(async |sftp| files::create_dir_all(sftp, path).await)
            .await
    }

    async fn home_dir(&self) -> anyhow::Result<Option<String>> {
        let home = self
            .with_sftp(async |sftp| sftp.canonicalize(".").await.map_err(|e| anyhow::anyhow!(e)))
            .await?;
        Ok(Some(home))
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<FileEntry>> {
        is_posix_absolute(path)?;
        self.with_sftp(async |sftp| files::read_dir(sftp, path).await).await
    }

    async fn open(&self, path: &str) -> anyhow::Result<Box<dyn AsyncReadSeek>> {
        is_posix_absolute(path)?;
        self.with_sftp(async |sftp| files::open(sftp, path).await).await
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        is_posix_absolute(path)?;
        self.with_sftp(async |sftp| files::remove_file(sftp, path).await).await
    }

    async fn stage_file(
        &self,
        name: &str,
        ext: &str,
        source: StageSource<'_>,
        mut on_progress: ProgressFn<'_>,
    ) -> anyhow::Result<String> {
        let owned;
        let bytes: &[u8] = match source {
            StageSource::Bytes(bytes) => bytes,
            StageSource::LocalFile(path) => {
                owned = tokio::fs::read(path).await?;
                &owned
            }
        };
        let path = format!("/tmp/{}", host_files::temp_file_name(name, ext));
        self.with_sftp(async |sftp| files::write_file(sftp, &path, bytes, &mut *on_progress).await)
            .await?;
        Ok(path)
    }
}

/// The shell line that runs one command on a remote machine.
///
/// Every part is quoted: the directory and the session file are host paths that
/// pi wrote or that a person picked, and they must not become shell syntax.
fn command_line(command: &CommandSpec) -> String {
    let mut line = String::new();
    if let Some(dir) = &command.current_dir {
        line.push_str("cd -- ");
        line.push_str(&quote(dir));
        line.push_str(" && ");
    }
    line.push_str(&quote(&command.program));
    for arg in &command.args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line
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
        assert!(!key.contains("BEGIN OPENSSH PRIVATE KEY"), "got `{key}`");
        assert!(!key.contains("AAAA"), "got `{key}`");
        assert!(!key.contains("hunter2"), "got `{key}`");
        assert!(key.contains("<redacted>"), "got `{key}`");
    }

    #[test]
    fn a_remote_pi_loads_a_session_file_through_a_quoted_path() {
        let command = CommandSpec::new("pi")
            .args(["--mode", "rpc"])
            .args(["--session", "/home/o'brien/sessions/one.jsonl"]);
        assert_eq!(
            command_line(&command),
            r"'pi' '--mode' 'rpc' '--session' '/home/o'\''brien/sessions/one.jsonl'"
        );
    }
}
