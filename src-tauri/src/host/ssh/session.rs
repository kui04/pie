//! One SSH connection, and what every channel on it hands back.
//!
//! [`SshSession::open`] is the reach: the socket, the key exchange, the host-key
//! question and the credentials. Everything after it is a channel on the same
//! connection - an exec channel that runs a command ([`SshSession::exec`]), one
//! that is captured whole ([`SshSession::output`]), and a subsystem
//! ([`SshSession::subsystem`]) - which is why a host needs one connection and not
//! one per channel.
//!
//! Timeouts live here, one per step, and each says why it is that long. The
//! handshake's own step has none on purpose: a person may be comparing a
//! fingerprint.

use std::io::Cursor;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use russh::client::{self, Config, Handle, Msg};
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key};
use russh::{Channel, ChannelMsg, Disconnect};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

use crate::channel::{Exec, Termination};
use crate::host::{Endpoint, Error, HostKey, Result, SshAuth, SshTarget, Trust};

use super::command::RemoteCommand;

/// How long the TCP connection to the host may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Silence after which an SSH keepalive is sent, so an idle session survives
/// NAT timeouts and a peer that vanished is eventually noticed.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// Keepalives that may stay unanswered before the session is declared dead.
const KEEPALIVE_MAX: usize = 3;

/// How long the server has to answer a channel request - run a command, start
/// a subsystem - before the channel is given up on.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the server has to accept or refuse the credentials.
///
/// Unlike the host key above it, nothing is waiting on a person here - and
/// russh's keepalives only start once the session is authenticated, so a host
/// that finishes the key exchange and then says nothing would otherwise hang
/// `open` with no way out: there is no lifecycle handle yet to terminate.
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a one-shot command has to finish.
///
/// The commands pie captures whole are small checks - a version probe, a
/// directory listing - where half a minute is generous. The bound is the promise
/// that the call returns whatever the command does.
const OUTPUT_TIMEOUT: Duration = Duration::from_secs(30);

/// How much of one stream a one-shot capture takes at most.
///
/// An API that reads to the end needs an end it can name. The calls pie makes
/// are small checks - a version probe, a whole directory's session summaries -
/// and a command that prints without stopping is ended at the cap the way `head`
/// ends a reader: that stream's prefix is kept, with the command's real status.
/// The other stream is dropped unread at that point: it cannot end while the
/// capped one has the copy stuck, and the capture pie already has is the one the
/// caller asked for.
const OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

/// SSH's extended-data code for a command's standard error.
const STDERR: u32 = 1;
/// An authenticated SSH session: one connection, many channels.
///
/// Pi runs in an exec channel ([`SshSession::exec`], one per session); the file
/// scans use a subsystem channel ([`SshSession::subsystem`]); and the small
/// checks beside them capture whole ([`SshSession::output`]). Dropping the
/// session closes the connection, and every channel on it with it.
pub struct SshSession {
    handle: Handle<Handler>,
    endpoint: Endpoint,
}

impl std::fmt::Debug for SshSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshSession")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl SshSession {
    /// The label of this host, for diagnostics and error messages.
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Whether the connection is still open.
    ///
    /// The handle reports on the task that drives the connection, and nothing
    /// crosses the network to ask. An SSH connection that ended - the network gone,
    /// the host asleep - answers `false` from here on.
    pub fn is_open(&self) -> bool {
        !self.handle.is_closed()
    }

    /// Reaches `target`, authenticates as `auth`, and keeps the connection open.
    ///
    /// The host key is submitted to `trust` during the handshake, which is why
    /// that step has no timeout: a first connection may wait for a person to
    /// compare a fingerprint. Everything after it is bounded.
    ///
    /// # Errors
    ///
    /// [`Error::ConnectTimeout`] when the TCP connection is not established in
    /// time, whatever the trust policy reports, [`Error::Ssh`] for anything the
    /// SSH layer fails on, [`Error::SshKey`] when a private key cannot be read
    /// or decrypted, [`Error::Auth`] when the host refuses the credentials and
    /// [`Error::AuthTimeout`] when it says nothing at all.
    pub async fn open(target: SshTarget, auth: SshAuth, trust: Trust) -> Result<Self> {
        let endpoint = target.endpoint();
        let config = Arc::new(Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            ..Config::default()
        });
        let handler = Handler {
            host: target.host.clone(),
            port: target.port,
            trust,
        };

        // Connected here rather than through `client::connect`, which offers no
        // timeout: the socket is where the timeout has to stop, or the wait for
        // a person to compare a fingerprint would be bounded too.
        let socket = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((target.host.as_str(), target.port)))
            .await
            .map_err(|_elapsed| Error::ConnectTimeout {
                endpoint: endpoint.to_string(),
                timeout: CONNECT_TIMEOUT,
            })?
            .map_err(|source| Error::Connect {
                endpoint: endpoint.to_string(),
                source,
            })?;
        // Nagle's algorithm is on in russh's default config, and the one place
        // russh applies `Config.nodelay` is `client::connect`, which opens its
        // own socket. This socket is opened here instead (for the timeout above),
        // and `connect_stream` takes a generic stream it cannot set options on,
        // so turning Nagle off is this code's job: without it an interactive
        // record waits for an acknowledgement.
        if let Err(error) = socket.set_nodelay(true) {
            tracing::debug!(%error, "could not disable Nagle's algorithm");
        }

        let mut handle = client::connect_stream(config, socket, handler).await?;
        tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut handle, &target, auth, &endpoint))
            .await
            .map_err(|_elapsed| Error::AuthTimeout {
                endpoint: endpoint.to_string(),
                timeout: AUTH_TIMEOUT,
            })??;

        tracing::debug!(endpoint = %endpoint, "ssh session established");
        Ok(Self { handle, endpoint })
    }

    /// Starts `command` in an exec channel of this session.
    ///
    /// # Errors
    ///
    /// [`Error::Exec`] when the host refuses to run the command, and
    /// [`Error::ExecTimeout`] when it does not say whether it can.
    pub async fn exec(&self, command: impl Into<RemoteCommand>) -> Result<Exec> {
        let command = command.into();
        let command_line = command.command_line();
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command_line.clone()).await?;
        let early = await_exec_reply(&mut channel, &self.endpoint, &command_line).await?;

        tracing::debug!(endpoint = %self.endpoint, command = %command_line, "ssh exec channel started");
        Ok(Exec::new(channel, self.endpoint.to_string(), command_line, early))
    }

    /// Runs `command` to completion and captures what it printed.
    ///
    /// The one-shot companion to [`SshSession::exec`] for the small checks an
    /// app runs beside pi - a version probe, a session summary script - where
    /// streams and a lifecycle handle would be plumbing. Bounded by
    /// `OUTPUT_TIMEOUT`: whatever the command does, this returns.
    ///
    /// # Errors
    ///
    /// [`SshSession::exec`]'s errors, and [`Error::ExecTimeout`] when the
    /// command does not finish in time. On expiry the command is sent the signal
    /// request a terminate sends - SIGKILL - and reading stops, so on any host
    /// that answers it the command does not outlive the call. A host that takes
    /// no signal request leaves the command running; nothing else pie can do
    /// about that without closing the channel, which is the one move here that
    /// never kills anything.
    pub async fn output(&self, command: impl Into<RemoteCommand>) -> Result<ExecOutput> {
        let command = command.into();
        let command_line = command.command_line();
        let exec = self.exec(command).await?;
        let (
            crate::channel::ssh::Pipes {
                stdout: mut reader,
                stdin: mut writer,
                stderr,
            },
            mut control,
        ) = exec.into_pipes();
        // Held as an option so the cap below can drop it: a stream nobody reads
        // is a stream the command blocks on writing.
        let mut diagnostics = Some(stderr);

        // The command is not reading anything pie has to say; its standard input
        // ends now, so a command that waits for input fails fast instead of
        // holding the bound below.
        let _ = writer.shutdown().await;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let started = std::time::Instant::now();
        // A read that stops at exactly the cap cannot tell "all of it" from
        // "the rest of it", so each stream is read one byte past the cap.
        let captured = tokio::time::timeout(OUTPUT_TIMEOUT, async {
            let out = (&mut reader).take(OUTPUT_BYTES + 1).read_to_end(&mut stdout).await;
            let mut over_cap = stdout.len() as u64 > OUTPUT_BYTES;
            if over_cap {
                // The command is still writing into a capture that has stopped
                // reading: this copy of the stream is stuck on a pipe that will
                // never move again, so waiting for the other stream below would
                // wait on that stuck copy until the whole bound is gone - taking
                // the bytes already read down with it. Dropping both readers is
                // what `head` does: the copies fail, the pump exits, and this
                // stream's prefix is what pie has. The other stream goes unread,
                // for the reason above.
                stdout.truncate(OUTPUT_BYTES as usize);
                drop(reader);
                diagnostics = None;
                tracing::debug!(endpoint = %self.endpoint, "the command printed past the capture cap; its output was cut there");
            }
            let err = async {
                if let Some(diagnostics) = diagnostics.as_mut() {
                    diagnostics.take(OUTPUT_BYTES + 1).read_to_end(&mut stderr).await?;
                }
                std::io::Result::Ok(0)
            }
            .await;
            over_cap |= stderr.len() as u64 > OUTPUT_BYTES;
            if over_cap {
                stderr.truncate(OUTPUT_BYTES as usize);
            }
            (out, err, over_cap)
        })
        .await;

        let (out, err, over_cap) = match captured {
            Ok(captured) => captured,
            Err(_elapsed) => {
                let _ = control.terminate().await;
                return Err(Error::ExecTimeout {
                    endpoint: self.endpoint.to_string(),
                    command: command_line,
                    timeout: OUTPUT_TIMEOUT,
                });
            }
        };
        // The capture is what it got, not what it was promised: a stream that
        // broke mid-command is the caller's reason to distrust the bytes, so it
        // is reported rather than swallowed.
        for (what, result) in [("stdout", out), ("stderr", err)] {
            if let Err(error) = result {
                tracing::warn!(endpoint = %self.endpoint, %error, what, "could not read the command's output to its end");
            }
        }
        // A capped command is still running: end it the way `head` ends a
        // reader, so `wait` has a status to report about what pie did to it.
        if over_cap {
            let _ = control.terminate().await;
        }

        let left = OUTPUT_TIMEOUT.saturating_sub(started.elapsed());
        let termination = match tokio::time::timeout(left, control.wait()).await {
            Ok(Ok(termination)) => termination,
            // The channel gave way before a status arrived. The bytes that did
            // arrive are still what the caller asked for, and the end is unknown
            // rather than cut short here.
            Ok(Err(error)) => {
                tracing::warn!(endpoint = %self.endpoint, %error, "the command's channel ended without a status");
                Termination::Unknown
            }
            Err(_elapsed) => {
                return Err(Error::ExecTimeout {
                    endpoint: self.endpoint.to_string(),
                    command: command_line,
                    timeout: OUTPUT_TIMEOUT,
                });
            }
        };
        Ok(ExecOutput {
            stdout,
            stderr,
            termination,
        })
    }

    /// Opens `name` as a subsystem channel of this session, like `sftp`.
    ///
    /// The returned stream is what a subsystem client reads and writes; pie's
    /// own file scans hand it to an sftp client outside this module.
    ///
    /// # Errors
    ///
    /// [`Error::Subsystem`] when the host refuses the subsystem - an sshd
    /// without `sftp` on its `Subsystem` line says so here - and
    /// [`Error::SubsystemTimeout`] when it does not answer at all.
    pub async fn subsystem(&self, name: &str) -> Result<SubsystemStream> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, name).await?;
        let early = await_subsystem_reply(&mut channel, &self.endpoint, name).await?;

        tracing::debug!(endpoint = %self.endpoint, subsystem = %name, "ssh subsystem channel started");
        Ok(SubsystemStream {
            early: Cursor::new(early),
            inner: channel.into_stream(),
        })
    }

    /// Ends the session, and every channel on it with it.
    ///
    /// Dropping the session does the same; this is for callers holding a shared
    /// hand to it - the app's slot hands out shared ones - who need the host
    /// gone now rather than when the last reader through it finishes.
    /// A session that is already gone is not a failure of closing it.
    pub async fn close(&self) {
        if let Err(error) = self
            .handle
            .disconnect(Disconnect::ByApplication, "pie closed the connection", "")
            .await
        {
            tracing::debug!(endpoint = %self.endpoint, %error, "the session was already gone");
        }
    }
}

/// What a command printed and how it ended ([`SshSession::output`]).
#[derive(Debug, Clone)]
pub struct ExecOutput {
    /// The command's standard output, truncated at `OUTPUT_BYTES`.
    pub stdout: Vec<u8>,
    /// The command's standard error, truncated at `OUTPUT_BYTES`.
    pub stderr: Vec<u8>,
    /// How the command ended.
    pub termination: Termination,
}

/// A subsystem channel's byte streams ([`SshSession::subsystem`]).
///
/// A newtype rather than the SSH library's own stream: what a caller does with
/// it - hand it to an sftp client - is not this module's business, and keeping
/// the concrete type out of the signature keeps that library out of everyone
/// else's API.
pub struct SubsystemStream {
    /// Bytes that arrived with the reply to the subsystem request. They belong
    /// to the stream even though they precede it, same as an exec channel's
    /// early output.
    early: Cursor<Vec<u8>>,
    inner: russh::ChannelStream<Msg>,
}

impl std::fmt::Debug for SubsystemStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SubsystemStream(<stream>)")
    }
}

impl AsyncRead for SubsystemStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let position = this.early.position() as usize;
        let held = this.early.get_ref();
        if position < held.len() {
            let take = (held.len() - position).min(buf.remaining());
            buf.put_slice(&held[position..position + take]);
            this.early.set_position((position + take) as u64);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for SubsystemStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// russh's callback surface, narrowed to the one question pie answers.
struct Handler {
    host: String,
    port: u16,
    trust: Trust,
}

impl client::Handler for Handler {
    type Error = Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool> {
        self.trust.verify(&self.host, self.port, key).await?;
        Ok(true)
    }
}

/// Authenticates the session, turning a refusal into [`Error::Auth`].
async fn authenticate(
    handle: &mut Handle<Handler>,
    target: &SshTarget,
    auth: SshAuth,
    endpoint: &Endpoint,
) -> Result<()> {
    let outcome = match auth {
        SshAuth::Password(password) => handle.authenticate_password(target.user.clone(), password).await?,
        SshAuth::Key { key, passphrase } => {
            let key = decode_secret_key(&key, passphrase.as_deref()).map_err(|source| Error::SshKey { source })?;
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
/// and the channel has no lifecycle handle yet, so a host that accepts the
/// connection and then says nothing could not be torn down from outside.
async fn await_exec_reply(
    channel: &mut Channel<Msg>,
    endpoint: &Endpoint,
    command: &str,
) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    loop {
        let message = match tokio::time::timeout(REPLY_TIMEOUT, channel.wait()).await {
            Ok(message) => message,
            Err(_elapsed) => {
                return Err(Error::ExecTimeout {
                    endpoint: endpoint.to_string(),
                    command: command.to_string(),
                    timeout: REPLY_TIMEOUT,
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

/// Waits for the server's reply to a subsystem request, like
/// [`await_exec_reply`] does for an exec request.
///
/// A refused subsystem is a fact about the host - an sshd without `sftp` on its
/// `Subsystem` line - so it is reported as [`Error::Subsystem`] rather than
/// folded into the exec errors. Early data is collected for the same reason as
/// there: a subsystem that answers before being asked is already speaking.
async fn await_subsystem_reply(channel: &mut Channel<Msg>, endpoint: &Endpoint, name: &str) -> Result<Vec<u8>> {
    let mut early = Vec::new();

    loop {
        let message = match tokio::time::timeout(REPLY_TIMEOUT, channel.wait()).await {
            Ok(message) => message,
            Err(_elapsed) => {
                return Err(Error::SubsystemTimeout {
                    endpoint: endpoint.to_string(),
                    name: name.to_string(),
                    timeout: REPLY_TIMEOUT,
                });
            }
        };
        match message {
            Some(ChannelMsg::Success) => return Ok(early),
            Some(ChannelMsg::Data { data }) => early.extend_from_slice(&data),
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                return Err(Error::Subsystem {
                    endpoint: endpoint.to_string(),
                    name: name.to_string(),
                });
            }
            Some(_) => {}
        }
    }
}
