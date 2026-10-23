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
//! the SSH implementation of [`Host`], which is what the rest of the
//! crate holds.
//!
mod command;
mod files;
mod known_hosts;
mod session;
mod trust;

pub use command::RemoteCommand;
use command::quote;
pub use known_hosts::KnownHosts;
pub use session::{ExecOutput, SshSession, SubsystemStream};
pub use trust::{AskHostKey, HostKey, PresentedKey, Trust};

use std::sync::{Arc, Mutex, PoisonError};

use russh_sftp::client::SftpSession;

use crate::channel::Channel;

use super::{
    Endpoint, FileEntry, Host, Listing, ProgressFn, SeekableReader, StageSource, check_version, checked_host_path,
    files as host_files, is_absolute_path,
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
    session: Mutex<Option<Arc<SshSession>>>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
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
    /// Call [`Host::connect`] to open the SSH connection and verify `pi`.
    pub fn new(target: SshTarget, auth: SshAuth, trust: Trust) -> Self {
        Self {
            target,
            auth,
            trust,
            session: Mutex::new(None),
            sftp: Mutex::new(None),
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
        self.session.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The file channel that is already open, if one is.
    pub(super) fn cached_sftp(&self) -> Option<Arc<SftpSession>> {
        self.sftp.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Keeps an open file channel for the reads that follow.
    pub(super) fn keep_sftp(&self, opened: &Arc<SftpSession>) {
        *self.sftp.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(opened));
    }

    /// Drops the file channel if it is still the one a failed read used.
    pub(super) fn forget_sftp(&self, used: &Arc<SftpSession>) {
        let mut slot = self.sftp.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().is_some_and(|cached| Arc::ptr_eq(cached, used)) {
            *slot = None;
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

    /// Drops the file channel whatever it is, for a session that is going away.
    pub(super) fn clear_sftp(&self) {
        *self.sftp.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[async_trait::async_trait]
impl Host for SshHost {
    async fn connect(&self) -> anyhow::Result<()> {
        let session = SshSession::open(self.target.clone(), self.auth.clone(), self.trust.clone()).await?;
        let output = session.output(RemoteCommand::new("pi --version")).await?;
        let version = parse_remote_version(&output, &self.target.endpoint())?;
        if let Err(mismatch) = check_version(&version) {
            tracing::warn!(%mismatch, "the pi of this machine is not the release pie speaks; going on");
        }

        self.clear_sftp();
        let previous = self
            .session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(Arc::new(session));
        if let Some(previous) = previous {
            previous.close().await;
        }
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.current_session().is_some_and(|session| session.is_open())
    }

    fn endpoint(&self) -> Endpoint {
        self.target.endpoint()
    }

    async fn open_pi(&self, cwd: &str, conversation: Option<&str>) -> anyhow::Result<(Channel, Option<String>)> {
        let conversation = conversation.map(checked_host_path).transpose()?;
        let cwd = checked_host_path(cwd)?;
        let command = RemoteCommand::new(pi_line(conversation)).cwd(cwd);
        let session = self.active_session()?;
        let channel = session.exec(command).await?.into_channel();
        Ok((channel, Some(cwd.to_string())))
    }

    async fn pi_version(&self) -> anyhow::Result<String> {
        let session = self.active_session()?;
        let output = session.output(RemoteCommand::new("pi --version")).await?;
        parse_remote_version(&output, &self.endpoint())
    }

    async fn dirs(&self, path: &str) -> anyhow::Result<Listing> {
        checked_host_path(path)?;
        self.with_sftp(async |sftp| files::dirs(sftp, path).await).await
    }

    async fn dir_exists(&self, path: &str) -> anyhow::Result<bool> {
        is_absolute_path(path)?;
        self.with_sftp(async |sftp| files::dir_exists(sftp, path).await).await
    }

    async fn create_dir(&self, path: &str) -> anyhow::Result<()> {
        is_absolute_path(path)?;
        self.with_sftp(async |sftp| files::create_dir(sftp, path).await).await
    }

    async fn home_dir(&self) -> anyhow::Result<Option<String>> {
        let home = self
            .with_sftp(async |sftp| sftp.canonicalize(".").await.map_err(|e| anyhow::anyhow!(e)))
            .await
            .ok();
        Ok(home)
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<FileEntry>> {
        is_absolute_path(path)?;
        self.with_sftp(async |sftp| files::read_dir(sftp, path).await).await
    }

    async fn open_file(&self, path: &str) -> anyhow::Result<Box<dyn SeekableReader>> {
        is_absolute_path(path)?;
        self.with_sftp(async |sftp| files::open_file(sftp, path).await).await
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        is_absolute_path(path)?;
        self.with_sftp(async |sftp| files::remove_file(sftp, path).await).await
    }

    async fn metadata(&self, path: &str) -> anyhow::Result<FileEntry> {
        is_absolute_path(path)?;
        self.with_sftp(async |sftp| files::metadata(sftp, path).await).await
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

    async fn close(&self) {
        self.clear_sftp();
        let session = self.session.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(session) = session {
            session.close().await;
            tracing::info!(endpoint = %self.endpoint(), "disconnected");
        }
    }
}

/// The line that starts pi on a remote machine, conversation included.
///
/// The conversation path is quoted: it is a host path that pi wrote or that a
/// person picked, and it must not become shell syntax.
fn pi_line(conversation: Option<&str>) -> String {
    match conversation {
        Some(path) => format!("pi --mode rpc --session {}", quote(path)),
        None => "pi --mode rpc".to_string(),
    }
}

/// Parses the output of `pi --version` executed remotely.
fn parse_remote_version(output: &ExecOutput, endpoint: &Endpoint) -> anyhow::Result<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let crate::channel::Termination::Exited { success: true, .. } = output.termination
        && !stdout.is_empty()
    {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let said = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if said.is_empty() {
        anyhow::bail!("`pi --version` on {endpoint} failed with {:?}", output.termination);
    } else {
        anyhow::bail!("`pi --version` on {endpoint} failed: {said}");
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
        assert!(!key.contains("BEGIN OPENSSH PRIVATE KEY"), "got `{key}`");
        assert!(!key.contains("AAAA"), "got `{key}`");
        assert!(!key.contains("hunter2"), "got `{key}`");
        assert!(key.contains("<redacted>"), "got `{key}`");
    }

    #[test]
    fn a_remote_pi_loads_a_conversation_through_a_quoted_path() {
        assert_eq!(pi_line(None), "pi --mode rpc");
        assert_eq!(
            pi_line(Some("/home/o'brien/sessions/one.jsonl")),
            r"pi --mode rpc --session '/home/o'\''brien/sessions/one.jsonl'"
        );
    }
}
