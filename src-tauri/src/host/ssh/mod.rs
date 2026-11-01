//! A machine reached over SSH, its channels, and its SFTP files.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{Context as _, ensure};
use bytes::{Bytes, BytesMut};
use hostaddr::HostAddr;
use russh::{ChannelMsg, Sig};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio_util::either::Either;
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf};

use crate::bus::Bus;
use crate::channel::{Channel, ExitStatus, Process};
use crate::host::executor::OsFamily;
use crate::host::fs::{FileOpenOptions, check_type, require_absolute, typed, uploads_dir};
use crate::host::{
    Command, CommandOutput, Executor, FileMetadata, FileSystem, HostAuth, HostFile, HostId,
    OUTPUT_TIMEOUT,
};

pub(crate) mod trust;
pub mod upload;

/// Maximum bytes `exec` collects across stdout and stderr before killing the command (4 MiB).
const EXEC_OUTPUT_CAP: usize = 4 * 1024 * 1024;

/// SFTP write chunk size (256 KiB), matching OpenSSH's optimal packet budget.
pub(crate) const SFTP_COPY_BUFFER: usize = 256 * 1024;

/// Recommended SSH channel initial window size (4 MiB).
const CHANNEL_WINDOW_SIZE: u32 = 4 * 1024 * 1024;

/// Recommended SSH maximum packet size (260 KiB).
const MAX_PACKET_SIZE: u32 = 260 * 1024;

/// Default SFTP subsystem operation timeout in seconds.
const SFTP_TIMEOUT_SECS: u64 = 30;

/// SSH extended-data code for standard error.
const EXT_STDERR: u32 = 1;

/// SIGKILL under POSIX numbering.
const SIGKILL: i32 = 9;

/// The russh callback surface: the server key of every connection is checked here.
pub struct ClientHandler {
    /// The trust question of this connection.
    prompt: trust::TrustPrompt,
}

impl ClientHandler {
    pub(crate) fn new(prompt: trust::TrustPrompt) -> Self {
        Self { prompt }
    }
}

impl std::fmt::Debug for ClientHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ClientHandler")
    }
}

impl russh::client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => {
                self.prompt.decide(key).await
            }
            // Nothing pie records describes the signing key of a certificate, so a
            // certificate cannot be a trusted first use.
            russh::keys::PublicKeyOrCertificate::Certificate(_) => Ok(false),
        }
    }
}

/// A machine reached over SSH. One connection carries every channel on it.
pub struct SshHost {
    /// The one connection every channel on this machine rides on.
    handle: Arc<russh::client::Handle<ClientHandler>>,
    /// The file session, opened on first use and shared after that.
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    /// The system this machine runs, read at connect from the home its sftp
    /// session reports: a drive letter means Windows, a root slash Unix.
    family: OsFamily,
    /// The login home directory reported by SFTP `canonicalize(".")`.
    home: Utf8TypedPathBuf,
    /// The cache directory of this machine: `~/.cache` on Unix, `~\AppData\Local` on Windows.
    cache: Utf8TypedPathBuf,
    /// The target address (`host[:port]`) for logs and error context.
    host: HostAddr<String>,
    /// Lazy-initialized deduplicating and resumable file uploader.
    uploader: OnceLock<upload::Uploader>,
}

impl std::fmt::Debug for SshHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("SshHost").field(&self.host).finish()
    }
}

impl SshHost {
    /// Dials `host` as `user`, authenticates with `auth`, and probes the remote OS family and home.
    ///
    /// The server key is checked against `known_hosts` before the dial completes, and an
    /// unknown key is put to the person through `bus`, under the name `connection`.
    pub async fn connect(
        user: &str,
        connection: HostId,
        host: HostAddr<String>,
        auth: &HostAuth,
        bus: Bus,
        known_hosts: trust::KnownHosts,
    ) -> anyhow::Result<Self> {
        let port = host.port().unwrap_or(22);

        let config = Arc::new(russh::client::Config {
            nodelay: true,
            window_size: CHANNEL_WINDOW_SIZE,
            maximum_packet_size: MAX_PACKET_SIZE,
            inactivity_timeout: Some(Duration::from_secs(60)),
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            ..russh::client::Config::default()
        });

        let prompt = trust::TrustPrompt::new(bus, connection, host.clone(), known_hosts);
        let mut handle = russh::client::connect(
            config,
            (host.host().to_string(), port),
            ClientHandler::new(prompt),
        )
        .await
        .with_context(|| format!("failed to connect to `{host}`"))?;

        authenticate(&mut handle, user, auth, &host).await?;

        let sftp = Arc::new(open_sftp_session(&handle, &host).await?);
        let raw_home = sftp
            .canonicalize(".")
            .await
            .with_context(|| format!("failed to resolve home directory on `{host}`"))?;

        let (family, home) = parse_remote_home(&raw_home);
        let cache = match family {
            OsFamily::Unix => home.join(".cache"),
            OsFamily::Windows => home.join("AppData").join("Local"),
        };

        Ok(Self {
            handle: Arc::new(handle),
            sftp: tokio::sync::Mutex::new(Some(sftp)),
            family,
            home,
            cache,
            host,
            uploader: OnceLock::new(),
        })
    }

    /// Whether the underlying SSH transport is still open.
    pub fn is_open(&self) -> bool {
        !self.handle.is_closed()
    }

    /// A check of the same fact that a task can hold after this host is gone.
    pub(crate) fn openness(&self) -> Box<dyn Fn() -> bool + Send + Sync> {
        let handle = Arc::clone(&self.handle);
        Box::new(move || !handle.is_closed())
    }

    /// Closes the SSH connection cleanly.
    pub async fn disconnect(&self) -> anyhow::Result<()> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "pie disconnecting", "en")
            .await
            .with_context(|| format!("failed to disconnect from `{}`", self.host))
    }

    /// Returns the shared SFTP session, replacing it if none is cached or the channel died.
    pub(crate) async fn sftp(&self) -> anyhow::Result<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(session) = guard.as_ref() {
            if session.try_exists(".").await.is_ok() {
                return Ok(Arc::clone(session));
            }
            tracing::debug!(
                host = %self.host,
                "cached SFTP session is no longer live; opening a replacement"
            );
            *guard = None;
        }
        let session = Arc::new(open_sftp_session(&self.handle, &self.host).await?);
        *guard = Some(Arc::clone(&session));
        Ok(session)
    }

    /// Returns the resumable, deduplicating [`upload::Uploader`] rooted at `<cache dir>/pie/uploads`.
    pub fn uploader(&self) -> &upload::Uploader {
        self.uploader.get_or_init(|| {
            upload::Uploader::new(
                Arc::clone(&self.handle),
                uploads_dir(self.cache.to_path()).to_path(),
                self.family,
                self.host.clone(),
            )
        })
    }
}

/// Authenticates `handle` using the credentials in `auth`.
async fn authenticate(
    handle: &mut russh::client::Handle<ClientHandler>,
    user: &str,
    auth: &HostAuth,
    host: &HostAddr<String>,
) -> anyhow::Result<()> {
    let outcome = match auth {
        HostAuth::None => handle
            .authenticate_none(user)
            .await
            .with_context(|| format!("`none` authentication failed on `{host}`"))?,
        HostAuth::Password(password) => handle
            .authenticate_password(user, password)
            .await
            .with_context(|| format!("password authentication failed on `{host}`"))?,
        HostAuth::Key {
            private_key,
            passphrase,
        } => {
            let key_pair = russh::keys::decode_secret_key(private_key, passphrase.as_deref())
                .with_context(|| format!("failed to decode private key for `{host}`"))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .with_context(|| format!("failed to negotiate RSA hash algorithm with `{host}`"))?
                .flatten();
            let key_with_alg =
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg);
            handle
                .authenticate_publickey(user, key_with_alg)
                .await
                .with_context(|| format!("public-key authentication failed on `{host}`"))?
        }
    };

    ensure!(outcome.success(), "authentication rejected by `{host}`");
    Ok(())
}

/// Opens a new SSH session channel and starts the SFTP subsystem on it.
pub(crate) async fn open_sftp_session(
    handle: &russh::client::Handle<ClientHandler>,
    host: &HostAddr<String>,
) -> anyhow::Result<SftpSession> {
    let channel = handle
        .channel_open_session()
        .await
        .with_context(|| format!("failed to open SFTP channel on `{host}`"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .with_context(|| format!("failed to request SFTP subsystem on `{host}`"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .with_context(|| format!("failed to initialize SFTP session on `{host}`"))?;
    sftp.set_timeout(SFTP_TIMEOUT_SECS);
    Ok(sftp)
}

/// Infers [`OsFamily`] and normalizes the home path returned by SFTP `canonicalize(".")`.
///
/// OpenSSH on Windows returns `/C:/Users/u` or `C:/Users/u`; Unix servers return `/home/u`.
fn parse_remote_home(raw: &str) -> (OsFamily, Utf8TypedPathBuf) {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();

    // Detect `/C:/...` or `/C:\...` returned by Windows OpenSSH SFTP.
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        return (OsFamily::Windows, typed(&trimmed[1..], OsFamily::Windows));
    }

    // Detect `C:/...` or `C:\...` or UNC `\\server\share`.
    if (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || trimmed.starts_with(r"\\")
    {
        return (OsFamily::Windows, typed(trimmed, OsFamily::Windows));
    }

    (OsFamily::Unix, typed(trimmed, OsFamily::Unix))
}

/// Converts a checked machine path into the wire string SFTP expects.
pub(crate) fn to_sftp_wire_path(path: Utf8TypedPath<'_>) -> String {
    match path {
        Utf8TypedPath::Unix(unix) => unix.as_str().to_owned(),
        Utf8TypedPath::Windows(win) => win.with_unix_encoding().into_string(),
    }
}

/// Opens an SSH session channel, sends an `exec` request, and collects any output
/// or exit status that arrived before the server confirmed the request.
async fn open_exec_channel(
    handle: &russh::client::Handle<ClientHandler>,
    line: &str,
    host: &HostAddr<String>,
) -> anyhow::Result<(
    russh::Channel<russh::client::Msg>,
    crate::channel::ssh::EarlyChannelOutput,
)> {
    let mut channel = handle
        .channel_open_session()
        .await
        .with_context(|| format!("failed to open exec channel on `{host}`"))?;

    channel
        .exec(true, line)
        .await
        .with_context(|| format!("failed to send exec request on `{host}`"))?;

    let mut early = crate::channel::ssh::EarlyChannelOutput {
        stdout: Vec::new(),
        stderr: Vec::new(),
        exit: None,
    };

    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => break,
            Some(ChannelMsg::Failure) => {
                anyhow::bail!("remote host `{host}` refused the exec request")
            }
            Some(ChannelMsg::Data { data }) => early.stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData {
                data,
                ext: EXT_STDERR,
            }) => early.stderr.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                early.exit = Some(ExitStatus::exited(exit_status as i32));
            }
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                early.exit = ExitStatus::try_from(signal_name).ok();
            }
            Some(ChannelMsg::Close) | None => {
                anyhow::bail!("exec channel on `{host}` closed before confirming request")
            }
            Some(_) => {}
        }
    }

    Ok((channel, early))
}

impl Executor for SshHost {
    async fn family(&self) -> OsFamily {
        self.family
    }

    async fn spawn(&self, cmd: Command) -> anyhow::Result<(Channel, Process)> {
        let program = cmd.program.clone();
        let line = cmd.into_shell_line(self.family)?;
        let (ssh_channel, early) = tokio::time::timeout(
            OUTPUT_TIMEOUT,
            open_exec_channel(&self.handle, &line, &self.host),
        )
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "opening the channel for `{program}` on `{}` timed out after {}s",
                self.host,
                OUTPUT_TIMEOUT.as_secs()
            )
        })??;
        let (channel, process) = crate::channel::ssh::spawn(ssh_channel, early);
        Ok((channel, Process::Ssh(process)))
    }

    async fn exec(&self, cmd: Command) -> anyhow::Result<CommandOutput> {
        let program = cmd.program.clone();
        let line = cmd.into_shell_line(self.family)?;

        let run = async {
            let (mut channel, early) = open_exec_channel(&self.handle, &line, &self.host).await?;

            let mut stdout = BytesMut::from(&early.stdout[..]);
            let mut stderr = BytesMut::from(&early.stderr[..]);
            let mut total_bytes = stdout.len() + stderr.len();
            let mut exit_status = early.exit;

            loop {
                if total_bytes > EXEC_OUTPUT_CAP {
                    let _ = channel.signal(Sig::KILL).await;
                    let _ = channel.eof().await;
                    anyhow::bail!(
                        "`{program}` on `{}` exceeded the {} MiB output limit",
                        self.host,
                        EXEC_OUTPUT_CAP / (1024 * 1024)
                    );
                }
                let Some(message) = channel.wait().await else {
                    break;
                };
                match message {
                    ChannelMsg::Data { data } => {
                        total_bytes = total_bytes.saturating_add(data.len());
                        stdout.extend_from_slice(&data);
                    }
                    ChannelMsg::ExtendedData {
                        data,
                        ext: EXT_STDERR,
                    } => {
                        total_bytes = total_bytes.saturating_add(data.len());
                        stderr.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus {
                        exit_status: status,
                    } => {
                        exit_status = Some(ExitStatus::exited(status as i32));
                    }
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        exit_status = Some(
                            ExitStatus::try_from(signal_name)
                                .unwrap_or_else(|_| ExitStatus::signalled(SIGKILL)),
                        );
                    }
                    _ => {}
                }
            }

            let exit_status = exit_status.with_context(|| {
                format!(
                    "`{program}` on `{}` ended without an exit status",
                    self.host
                )
            })?;

            Ok(CommandOutput {
                stdout: stdout.freeze(),
                stderr: stderr.freeze(),
                exit_status,
            })
        };

        tokio::time::timeout(OUTPUT_TIMEOUT, run)
            .await
            .with_context(|| {
                format!(
                    "`{program}` on `{}` did not answer within {OUTPUT_TIMEOUT:?}",
                    self.host
                )
            })?
    }
}

impl FileSystem for SshHost {
    async fn home_dir(&self) -> anyhow::Result<Utf8TypedPathBuf> {
        Ok(self.home.clone())
    }

    async fn cache_dir(&self) -> anyhow::Result<Utf8TypedPathBuf> {
        Ok(self.cache.clone())
    }

    async fn metadata(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<FileMetadata> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;
        row_of(&sftp, path).await
    }

    async fn read_dir(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<Vec<FileMetadata>> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;
        let wire_path = to_sftp_wire_path(path);

        let entries = sftp
            .read_dir(wire_path)
            .await
            .with_context(|| format!("cannot read {path}"))?;

        let mut rows = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let entry_path = path.join(&name);
            let meta = entry.metadata();
            let is_symlink = meta.is_symlink();

            let shown = if is_symlink {
                let target_wire = to_sftp_wire_path(entry_path.to_path());
                sftp.metadata(target_wire).await.ok().unwrap_or(meta)
            } else {
                meta
            };

            rows.push(file_metadata_from_attrs(entry_path, &shown, is_symlink));
        }
        Ok(rows)
    }

    async fn is_dir(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<bool> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;

        match sftp.metadata(to_sftp_wire_path(path)).await {
            Ok(attributes) => Ok(attributes.is_dir()),
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
            {
                Ok(false)
            }
            Err(error) => Err(error).with_context(|| format!("cannot check {path}")),
        }
    }

    async fn open_file(
        &self,
        path: Utf8TypedPath<'_>,
        options: FileOpenOptions,
    ) -> anyhow::Result<HostFile> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;
        let flags = OpenFlags::from(&options);
        let wire_path = to_sftp_wire_path(path);

        let file = sftp
            .open_with_flags(wire_path, flags)
            .await
            .with_context(|| format!("cannot open {path}"))?;
        Ok(Either::Right(file))
    }

    async fn read_bytes(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<Bytes> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;
        let wire_path = to_sftp_wire_path(path);

        let bytes = sftp
            .read(wire_path)
            .await
            .with_context(|| format!("cannot read {path}"))?;
        Ok(Bytes::from(bytes))
    }

    async fn write_from<R>(
        &self,
        path: Utf8TypedPath<'_>,
        mut source: R,
        progress: watch::Sender<u64>,
    ) -> anyhow::Result<()>
    where
        R: AsyncRead + Unpin + Send,
    {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;
        let wire_path = to_sftp_wire_path(path);

        let mut file = sftp
            .open_with_flags(
                wire_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .with_context(|| format!("cannot create {path}"))?;

        let mut buffer = vec![0u8; SFTP_COPY_BUFFER].into_boxed_slice();
        let mut written = 0u64;

        loop {
            let read = source
                .read(&mut buffer)
                .await
                .with_context(|| format!("cannot read the file of {path}"))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .await
                .with_context(|| format!("cannot write {path}"))?;
            written += read as u64;
            progress.send_replace(written);
        }

        file.flush()
            .await
            .with_context(|| format!("cannot write {path}"))?;
        file.shutdown()
            .await
            .with_context(|| format!("cannot close {path}"))?;
        Ok(())
    }

    async fn remove(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<()> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;
        let wire_path = to_sftp_wire_path(path);

        sftp.remove_file(wire_path)
            .await
            .with_context(|| format!("cannot remove {path}"))
    }

    async fn create_dir_all(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<()> {
        let path = require_absolute(path)?;
        check_type(path, self.family)?;
        let sftp = self.sftp().await?;

        let mut ancestors: Vec<Utf8TypedPath<'_>> = path
            .ancestors()
            .filter(|ancestor| !ancestor.as_str().is_empty())
            .collect();
        ancestors.reverse();

        for level in ancestors {
            let wire = to_sftp_wire_path(level);
            if sftp
                .try_exists(&wire)
                .await
                .with_context(|| format!("cannot check {level}"))?
            {
                continue;
            }
            if let Err(error) = sftp.create_dir(&wire).await
                && !sftp.try_exists(&wire).await.unwrap_or(false)
            {
                return Err(error).with_context(|| format!("cannot make {level}"));
            }
        }
        Ok(())
    }
}

/// Reads the row of one entry over SFTP, following symlinks with a second metadata call.
async fn row_of(sftp: &SftpSession, path: Utf8TypedPath<'_>) -> anyhow::Result<FileMetadata> {
    let wire_path = to_sftp_wire_path(path);
    let entry = sftp
        .symlink_metadata(&wire_path)
        .await
        .with_context(|| format!("cannot read {path}"))?;
    let is_symlink = entry.is_symlink();
    let target = if is_symlink {
        sftp.metadata(&wire_path).await.ok()
    } else {
        None
    };
    let shown = target.as_ref().unwrap_or(&entry);
    Ok(file_metadata_from_attrs(
        path.to_path_buf(),
        shown,
        is_symlink,
    ))
}

/// Converts `russh_sftp` attributes into [`FileMetadata`].
fn file_metadata_from_attrs(
    path: Utf8TypedPathBuf,
    attrs: &russh_sftp::protocol::FileAttributes,
    is_symlink: bool,
) -> FileMetadata {
    let modified = attrs
        .mtime
        .map(|secs| UNIX_EPOCH + Duration::from_secs(u64::from(secs)));
    FileMetadata {
        is_file: attrs.is_regular(),
        is_dir: attrs.is_dir(),
        is_symlink,
        len: attrs.size,
        path,
        modified,
        created: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unix_home_is_recognized_as_unix() {
        let (family, path) = parse_remote_home("/home/alice");
        assert_eq!(family, OsFamily::Unix);
        assert!(path.is_unix());
        assert_eq!(path.as_str(), "/home/alice");
    }

    #[test]
    fn a_windows_openssh_home_with_leading_slash_becomes_a_windows_path() {
        let (family, path) = parse_remote_home("/C:/Users/alice");
        assert_eq!(family, OsFamily::Windows);
        assert!(path.is_windows());
        assert_eq!(path.as_str(), "C:/Users/alice");
    }

    #[test]
    fn a_windows_drive_home_is_recognized_as_windows() {
        let (family, path) = parse_remote_home("D:\\Users\\alice");
        assert_eq!(family, OsFamily::Windows);
        assert!(path.is_windows());
        assert_eq!(path.as_str(), "D:\\Users\\alice");
    }
}
