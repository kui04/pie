//! pi over an SSH exec channel.
//!
//! pi keeps running on the host that has it: pie reaches it with `pi --mode rpc`
//! inside one exec channel of an SSH session. This module is that transport and
//! nothing more - it reaches a host, authenticates, starts a command, and hands
//! back byte streams. Which command to run, which sessions exist on the host,
//! and the SFTP channel that scans them are app concerns and live outside
//! `pi_rpc`, whose boundary `tests/purity.rs` enforces.
//!
//! ```no_run
//! use std::sync::Arc;
//!
//! use pie_lib::pi_rpc::transport::{HostKey, SshAuth, SshTarget, SshTransport};
//!
//! # async fn example() -> pie_lib::pi_rpc::Result<()> {
//! struct Trust; // an app's TOFU policy, told what the host presented
//!
//! impl HostKey for Trust {
//!     fn verify(
//!         &self,
//!         _host: &str,
//!         _port: u16,
//!         key: &pie_lib::pi_rpc::transport::PublicKey,
//!     ) -> std::pin::Pin<Box<dyn std::future::Future<Output = pie_lib::pi_rpc::Result<()>> + Send + '_>> {
//!         let certified = key.certificate().is_some();
//!         Box::pin(async move {
//!             println!("certified: {certified}");
//!             Ok(())
//!         })
//!     }
//! }
//!
//! let transport = SshTransport::open(
//!     SshTarget::new("example.com", "pi"),
//!     SshAuth::Password("hunter2".to_string()),
//!     Arc::new(Trust),
//! )
//! .await?;
//! # let _ = transport;
//! # Ok(())
//! # }
//! ```

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use russh::client::{self, Config, Handle, Msg};
use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use russh::{Channel, ChannelMsg, Disconnect, Sig};
use tokio::io::{AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::watch;

use super::{Control, Termination, Transport, TransportParts};
use crate::pi_rpc::error::{Error, Result};

/// Reserved for callers that want to name the key type without pulling in
/// `russh` themselves: this is what a [`HostKey`] verifier is handed.
pub use russh::keys::PublicKeyOrCertificate as PublicKey;

/// Bytes a direction may buffer between the SSH channel and the client.
///
/// This is flow control, not storage: a full pipe stops the pump from reading
/// the channel, which stops the remote writer at the SSH window.
const PIPE_CAPACITY: usize = 64 * 1024;

/// How long the TCP connection to the host may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Silence after which an SSH keepalive is sent, so an idle session survives
/// NAT timeouts and a peer that vanished is eventually noticed.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// Keepalives that may stay unanswered before the session is declared dead.
const KEEPALIVE_MAX: usize = 3;

/// How long the server has to answer the request to run the command.
const EXEC_REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the server has to accept or refuse the credentials.
///
/// Unlike the host key above it, nothing is waiting on a person here - and
/// russh's keepalives only start once the session is authenticated, so a host
/// that finishes the key exchange and then says nothing would otherwise hang
/// `open` with no way out: there is no lifecycle handle yet to terminate.
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

/// SSH's extended-data code for a command's stderr.
const STDERR: u32 = 1;

/// How to identify at the SSH server.
#[derive(Clone)]
pub enum SshAuth {
    /// Password authentication.
    Password(String),
    /// Public-key authentication with the private key at this path.
    Key {
        /// Path of the private key. Pie reads it where it lies and never copies
        /// secret material into its own storage.
        path: PathBuf,
        /// Passphrase, when the key is encrypted.
        passphrase: Option<String>,
    },
}

impl std::fmt::Debug for SshAuth {
    /// Redacts secrets: this type reaches logs and error reports.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password(_) => formatter.write_str("Password(<redacted>)"),
            Self::Key { path, passphrase } => formatter
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

/// The host to reach and the command to run there.
#[derive(Debug, Clone)]
pub struct SshTarget {
    host: String,
    port: u16,
    user: String,
    command: String,
    dir: Option<String>,
}

impl SshTarget {
    /// Targets `host` as `user`: port 22, running `pi --mode rpc`.
    pub fn new(host: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            port: 22,
            user: user.into(),
            command: "pi --mode rpc".to_string(),
            dir: None,
        }
    }

    /// Uses another port.
    pub fn port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// Runs `command` instead of `pi --mode rpc`.
    pub fn command(mut self, command: impl Into<String>) -> Self {
        self.command = command.into();
        self
    }

    /// Starts the command in `dir`, for the shell that runs it remotely.
    ///
    /// The directory is quoted: it reaches us as user input from a directory
    /// picker and must not become shell syntax.
    pub fn cwd(mut self, dir: impl AsRef<str>) -> Self {
        self.dir = Some(dir.as_ref().to_string());
        self
    }

    /// The command as it will be run remotely, `cd` prefix included.
    ///
    /// Composed here rather than in [`SshTarget::cwd`] so that the working
    /// directory and the command are independent: whichever order they are set
    /// in, the result is the same. The remote working directory is how a
    /// session picks its project (see G2 in docs/TODO.md), so losing it to a
    /// later call would be a silent mistake.
    pub fn command_line(&self) -> String {
        match &self.dir {
            Some(dir) => format!("cd -- {} && {}", quote(dir), self.command),
            None => self.command.clone(),
        }
    }

    /// `user@host:port`, for diagnostics and error messages.
    pub fn endpoint(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
}

/// The app's verdict on the key a host presented.
///
/// Deciding what to trust is connection policy, not protocol, so the transport
/// asks and the app answers - with a stored key, a user's confirmation, or a
/// refusal.
pub trait HostKey: Send + Sync + 'static {
    /// Returns `Ok(())` to continue the handshake.
    ///
    /// # Errors
    ///
    /// Any error ends the handshake and surfaces from [`SshTransport::open`]
    /// unchanged - whatever the app's own reason is, such as
    /// [`Error::HostKeyRejected`] for a key it will not trust, or an I/O error
    /// from reading its key store. `host` and `port` are the endpoint as the
    /// app named it, so a verifier can key its store without parsing the
    /// address back out.
    ///
    /// The future is boxed because the transport holds the verifier as a trait
    /// object; it runs once per connection, where the allocation is nothing.
    fn verify(&self, host: &str, port: u16, key: &PublicKey) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;
}

/// An authenticated SSH session with its exec channel started.
///
/// The command is already running when this value exists; [`Transport::split`]
/// hands out its streams.
pub struct SshTransport {
    handle: Handle<Handler>,
    channel: Channel<Msg>,
    endpoint: String,
    command: String,
    /// Data that arrived with (or before) the server's reply to the exec
    /// request, kept so no byte of the command's output can be lost.
    early: (Vec<u8>, Vec<u8>),
}

impl std::fmt::Debug for SshTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshTransport")
            .field("endpoint", &self.endpoint)
            .field("command", &self.command)
            .finish_non_exhaustive()
    }
}

impl SshTransport {
    /// Reaches `target`, authenticates as `auth`, and starts the command.
    ///
    /// The host key is submitted to `verifier` during the handshake, which is
    /// why that step has no timeout: a first connection may wait for a person
    /// to compare a fingerprint. Everything after it is bounded.
    ///
    /// # Errors
    ///
    /// [`Error::ConnectTimeout`] when the TCP connection is not established in
    /// time, whatever [`HostKey`] reports, [`Error::Ssh`] for anything the SSH
    /// layer fails on, [`Error::SshKey`] when a private key cannot be read or
    /// decrypted, [`Error::Auth`] when the host refuses the credentials and
    /// [`Error::AuthTimeout`] when it says nothing at all,
    /// [`Error::Exec`] when it refuses to run the command, and
    /// [`Error::ExecTimeout`] when it does not say whether it can.
    pub async fn open(target: SshTarget, auth: SshAuth, verifier: Arc<dyn HostKey>) -> Result<Self> {
        let endpoint = target.endpoint();
        let config = Arc::new(Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            ..Config::default()
        });
        let handler = Handler {
            host: target.host.clone(),
            port: target.port,
            verifier,
        };

        // Connected here rather than through `client::connect`, which offers no
        // timeout: the socket is where the timeout has to stop, or the wait for
        // a person to compare a fingerprint would be bounded too.
        let socket = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((target.host.as_str(), target.port)))
            .await
            .map_err(|_elapsed| Error::ConnectTimeout {
                endpoint: endpoint.clone(),
                timeout: CONNECT_TIMEOUT,
            })?
            .map_err(|source| Error::Connect {
                endpoint: endpoint.clone(),
                source,
            })?;
        // Nagle's algorithm is on in russh's default config, and the one place
        // russh applies `Config.nodelay` is `client::connect`, which opens its
        // own socket. This socket is opened here instead (for the timeout
        // above), and `connect_stream` takes a generic stream it cannot set
        // options on, so turning Nagle off is this code's job: without it an
        // interactive record waits for an acknowledgement.
        if let Err(error) = socket.set_nodelay(true) {
            tracing::debug!(%error, "could not disable Nagle's algorithm");
        }

        let mut handle = client::connect_stream(config, socket, handler).await?;
        tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut handle, &target, auth, &endpoint))
            .await
            .map_err(|_elapsed| Error::AuthTimeout {
                endpoint: endpoint.clone(),
                timeout: AUTH_TIMEOUT,
            })??;

        let command = target.command_line();
        let mut channel = handle.channel_open_session().await?;
        channel.exec(true, command.clone()).await?;
        let early = await_exec_reply(&mut channel, &endpoint, &command).await?;

        tracing::debug!(endpoint = %endpoint, command = %command, "ssh exec channel started");
        Ok(Self {
            handle,
            channel,
            endpoint,
            command: target.command,
            early,
        })
    }
}

/// The streams of an SSH exec channel.
impl Transport for SshTransport {
    type Reader = DuplexStream;
    type Writer = Box<dyn AsyncWrite + Unpin + Send + 'static>;
    type Control = SshControl;

    fn split(self) -> Result<TransportParts<Self::Reader, Self::Writer, Self::Control>> {
        let Self {
            handle,
            channel,
            endpoint,
            command: _,
            early,
        } = self;
        let (read_half, write_half) = channel.split();

        let (stdout_tx, stdout_rx) = tokio::io::duplex(PIPE_CAPACITY);
        let (stderr_tx, stderr_rx) = tokio::io::duplex(PIPE_CAPACITY);
        let (exit_tx, exit_rx) = watch::channel(None);
        tokio::spawn(pump(read_half, stdout_tx, stderr_tx, early, exit_tx));

        Ok(TransportParts {
            reader: stdout_rx,
            // russh's opaque writer: its `poll_shutdown` sends the channel EOF
            // that gives the remote pi EOF on stdin.
            writer: Box::new(write_half.make_writer()),
            control: SshControl {
                endpoint,
                handle,
                exit: exit_rx,
            },
            diagnostics: Some(Box::new(stderr_rx)),
        })
    }
}

/// Lifecycle of the command behind an [`SshTransport`].
pub struct SshControl {
    endpoint: String,
    handle: Handle<Handler>,
    exit: watch::Receiver<Option<Termination>>,
}

impl std::fmt::Debug for SshControl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshControl")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl Control for SshControl {
    async fn terminate(&mut self) -> Result<()> {
        // Closing the session ends every channel on it, which is what stops the
        // remote command: an exec channel has no signal to send.
        tracing::debug!(endpoint = %self.endpoint, "disconnecting the ssh session");
        self.handle
            .disconnect(Disconnect::ByApplication, "pie closed the connection", "")
            .await?;
        Ok(())
    }

    async fn wait(&mut self) -> Result<Termination> {
        loop {
            if let Some(termination) = *self.exit.borrow_and_update() {
                return Ok(termination);
            }
            if self.exit.changed().await.is_err() {
                // The pump is gone without an exit status: the session died.
                return Ok(Termination::Unknown);
            }
        }
    }
}

/// russh's callback surface, narrowed to the two questions pie answers.
struct Handler {
    host: String,
    port: u16,
    verifier: Arc<dyn HostKey>,
}

impl client::Handler for Handler {
    type Error = Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool> {
        self.verifier.verify(&self.host, self.port, key).await?;
        Ok(true)
    }
}

/// Authenticates the session, turning a refusal into [`Error::Auth`].
async fn authenticate(handle: &mut Handle<Handler>, target: &SshTarget, auth: SshAuth, endpoint: &str) -> Result<()> {
    let outcome = match auth {
        SshAuth::Password(password) => handle.authenticate_password(target.user.clone(), password).await?,
        SshAuth::Key { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_deref()).map_err(|source| Error::SshKey {
                path: path.clone(),
                source,
            })?;
            // RSA stands between `ssh-rsa` and the SHA-2 variants; the server
            // advertises which it accepts, and anything else ignores this.
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle.authenticate_publickey(target.user.clone(), key).await?
        }
    };

    if outcome.success() {
        return Ok(());
    }
    Err(Error::Auth {
        endpoint: endpoint.to_string(),
    })
}

/// Waits for the server's reply to the exec request.
///
/// Without it a command that does not exist would look like a connection that
/// works and then dies silently. Data is collected rather than dropped: it can
/// only mean the command is already running, and the stream must still see it.
///
/// Bounded, unlike the handshake before it: nothing is waiting on a person here,
/// and the transport has no lifecycle handle yet, so a host that accepts the
/// connection and then says nothing could not be torn down from outside.
async fn await_exec_reply(channel: &mut Channel<Msg>, endpoint: &str, command: &str) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    loop {
        let message = match tokio::time::timeout(EXEC_REPLY_TIMEOUT, channel.wait()).await {
            Ok(message) => message,
            Err(_elapsed) => {
                return Err(Error::ExecTimeout {
                    endpoint: endpoint.to_string(),
                    command: command.to_string(),
                    timeout: EXEC_REPLY_TIMEOUT,
                });
            }
        };
        match message {
            Some(ChannelMsg::Success) => return Ok((stdout, stderr)),
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, ext }) if ext == STDERR => {
                stderr.extend_from_slice(&data);
            }
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                return Err(Error::Exec {
                    endpoint: endpoint.to_string(),
                    command: command.to_string(),
                });
            }
            Some(_) => {}
        }
    }
}

/// Moves the channel's messages into the byte streams the client reads.
///
/// stdout and stderr are separate SSH messages on one channel while the client
/// wants two streams, so each is copied into a pipe of its own. The channel's
/// exit status is this module's only source for [`Control::wait`], which is why
/// it is collected here.
async fn pump(
    mut channel: russh::ChannelReadHalf,
    mut stdout: DuplexStream,
    mut stderr: DuplexStream,
    early: (Vec<u8>, Vec<u8>),
    exit: watch::Sender<Option<Termination>>,
) {
    let (early_stdout, early_stderr) = early;
    if stdout.write_all(&early_stdout).await.is_err() {
        // Nobody is reading: the client is gone.
        let _ = exit.send(Some(Termination::Unknown));
        return;
    }
    let mut termination = Termination::Unknown;
    let mut dropped_stderr = 0usize;
    // Same policy as below, for bytes that arrived with the exec reply.
    dropped_stderr += early_stderr.len() - write_now(&mut stderr, &early_stderr);

    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                if stdout.write_all(&data).await.is_err() {
                    break;
                }
            }
            // Diagnostics, not protocol: written only while there is room, and
            // dropped when there is not. Blocking here instead would stall the
            // stream pi is speaking on and the exit status with it - and the
            // consumer of a diagnostics stream is the one most likely to stop
            // reading. The count is reported so the loss is visible in logs
            // rather than silent.
            ChannelMsg::ExtendedData { data, ext } if ext == STDERR => {
                dropped_stderr += data.len() - write_now(&mut stderr, &data);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                termination = Termination::Exited {
                    code: exit_status as i32,
                    success: exit_status == 0,
                };
            }
            ChannelMsg::ExitSignal { signal_name, .. } => {
                termination = termination_of(signal_name);
            }
            _ => {}
        }
    }

    // Dropping the write ends is what gives the client its EOF; buffered bytes
    // are still read out first.
    drop(stdout);
    drop(stderr);
    if dropped_stderr > 0 {
        tracing::debug!(
            target: "pi_rpc::ssh",
            bytes = dropped_stderr,
            "dropped pi stderr nobody was reading"
        );
    }
    let _ = exit.send(Some(termination));
}

/// Writes as much of `data` as fits right now, never waiting, and reports how
/// much that was.
///
/// Polled once on purpose: this is the diagnostics stream, and a consumer that
/// stopped reading must not turn into a wait inside the copy that also carries
/// the protocol. `AsyncWrite` for a pipe has no `try_write`, and a full pipe is
/// reported the same way as a reader that is gone: nothing was written.
fn write_now(stream: &mut DuplexStream, data: &[u8]) -> usize {
    let mut context = Context::from_waker(Waker::noop());
    match Pin::new(&mut *stream).poll_write(&mut context, data) {
        Poll::Ready(Ok(written)) => written,
        Poll::Ready(Err(_)) | Poll::Pending => 0,
    }
}

/// Maps an SSH exit signal onto [`Termination`], by signal number.
fn termination_of(signal: Sig) -> Termination {
    let number = match signal {
        Sig::HUP => 1,
        Sig::INT => 2,
        Sig::QUIT => 3,
        Sig::ILL => 4,
        Sig::ABRT => 6,
        Sig::FPE => 8,
        Sig::KILL => 9,
        Sig::USR1 => 10,
        Sig::SEGV => 11,
        Sig::PIPE => 13,
        Sig::ALRM => 14,
        Sig::TERM => 15,
        Sig::Custom(_) => return Termination::Unknown,
    };
    Termination::Signalled { signal: number }
}

/// Quotes `text` for a POSIX shell, so it reaches the remote command unmangled.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_names_the_user_host_and_port() {
        assert_eq!(SshTarget::new("example.com", "pi").endpoint(), "pi@example.com:22");
        assert_eq!(
            SshTarget::new("example.com", "pi").port(2222).endpoint(),
            "pi@example.com:2222"
        );
    }

    #[test]
    fn cwd_prefixes_a_quoted_directory() {
        assert_eq!(
            SshTarget::new("host", "user").cwd("/srv/work").command_line(),
            "cd -- '/srv/work' && pi --mode rpc"
        );
    }

    #[test]
    fn quoting_survives_quotes_and_spaces() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("with space"), "'with space'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(
            SshTarget::new("host", "user").cwd("/home/o'brien/pie").command_line(),
            r"cd -- '/home/o'\''brien/pie' && pi --mode rpc"
        );
    }

    #[test]
    fn custom_commands_replace_the_default_one() {
        assert_eq!(
            SshTarget::new("host", "user").command("sh -c 'echo hi'").command_line(),
            "sh -c 'echo hi'"
        );
    }

    #[test]
    fn the_working_directory_survives_the_command_being_set_after_it() {
        // Both orders, because the working directory is how a session picks its
        // project: whichever order the caller builds the target in, the command
        // runs there.
        let wanted = "cd -- '/srv/work' && pi --mode rpc";
        assert_eq!(
            SshTarget::new("host", "user")
                .cwd("/srv/work")
                .command("pi --mode rpc")
                .command_line(),
            wanted
        );
        assert_eq!(
            SshTarget::new("host", "user")
                .command("pi --mode rpc")
                .cwd("/srv/work")
                .command_line(),
            wanted
        );
        assert_eq!(
            SshTarget::new("host", "user")
                .cwd("/srv/work")
                .command("sh -c 'ls'")
                .command_line(),
            "cd -- '/srv/work' && sh -c 'ls'"
        );
    }

    #[test]
    fn auth_debug_output_never_prints_secrets() {
        let password = format!("{:?}", SshAuth::Password("hunter2".to_string()));
        assert_eq!(password, "Password(<redacted>)");

        let key = format!(
            "{:?}",
            SshAuth::Key {
                path: PathBuf::from("/home/me/.ssh/id_ed25519"),
                passphrase: Some("hunter2".to_string()),
            }
        );
        assert!(key.contains("/home/me/.ssh/id_ed25519"), "got `{key}`");
        assert!(!key.contains("hunter2"), "got `{key}`");
    }
}
