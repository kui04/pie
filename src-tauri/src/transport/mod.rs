//! Where pi runs, and how pie's bytes reach it.
//!
//! One protocol, two ways to reach a host: `pi --mode rpc` as a child process of
//! this machine, or in an exec channel of an SSH session. A transport only
//! produces a byte path and a lifecycle handle; the records on that path belong
//! to [`pi_rpc`], and which host to reach, which sessions exist on it, and what
//! to do when one ends belong to [`connection`](crate::connection).
//!
//! [`Peer`] is the app's word for a started peer: the bytes, and the process or
//! channel behind them. [`Peer::split`] takes it apart into the transport the
//! `pi_rpc` client talks over and a [`PeerHandle`] that says whether pi still
//! runs, ends it, and waits for its end.

mod error;
mod local;
mod ssh;
mod version;

pub use error::{Error, Result};
pub use local::{LocalProcess, LocalTransport};
pub use ssh::{
    ExecOutput, HostKey, PublicKey, RemoteCommand, SshAuth, SshControl, SshSession, SshTarget, SshTransport,
    SubsystemStream,
};
pub use version::{PI_VERSION, check_version, probe_version};

use std::future::Future;
use std::io::ErrorKind;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, watch};

use pi_rpc::frame::Decoder;
use pi_rpc::transport::{Transport, TransportRecv, TransportSend};

/// Bytes read from the peer per syscall. Records are assembled across chunks, so
/// this only tunes throughput.
const READ_BUFFER: usize = 32 * 1024;

/// How a peer stopped.
///
/// This is not a record of pi. No form of it appears in `rpc-types.ts`: it is
/// what pie observed about the process, or the channel, that ran pi. The app
/// sends it unchanged as the end of a session, so it carries a `type` tag and
/// snake_case values like the rest of the app's payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Termination {
    /// The peer exited with this status.
    Exited {
        /// Exit code.
        code: i32,
        /// Whether the code counts as success.
        success: bool,
    },
    /// The peer was killed by this signal.
    Signalled {
        /// Signal number.
        signal: i32,
    },
    /// The peer ended without a status pie can read.
    Unknown,
}

/// The process or channel behind a byte path.
///
/// A caller that only waits never needs this; [`PeerHandle`] is the one-hand
/// form. This trait is for the paths that drive a peer themselves, like the
/// one-shot capture of [`SshSession::output`].
///
/// Contract: once [`Lifecycle::wait`] resolves, the peer's bytes reached their
/// end too, so a reader has already seen everything the peer wrote.
pub trait Lifecycle: Send + 'static {
    /// Abruptly tears the peer down. For a process: kill and reap.
    fn terminate(&mut self) -> impl Future<Output = Result<()>> + Send;

    /// Waits for the peer to end and reports how it ended.
    fn wait(&mut self) -> impl Future<Output = Result<Termination>> + Send;
}

/// A started peer: one `pi --mode rpc`, with the process or channel running it.
#[derive(Debug)]
pub enum Peer {
    /// pi as a child process of this machine.
    Local(LocalProcess),
    /// pi in an exec channel of an SSH session.
    Ssh(SshTransport),
}

impl Peer {
    /// Takes the peer apart for the protocol client, and starts watching its end.
    ///
    /// # Errors
    ///
    /// Whatever the transport itself cannot hand over: the local process failing
    /// to hand back its pipes is the only case this crate has.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime, like the `pi_rpc` client's own start: the watch
    /// of the peer runs in a task of its own.
    pub fn split(self) -> Result<(Wire, PeerHandle)> {
        let (wire, lifecycle) = match self {
            Self::Local(process) => {
                let (wire, control) = process.split()?;
                (wire, Behind::Local(control))
            }
            Self::Ssh(transport) => {
                let (wire, control) = transport.split()?;
                (wire, Behind::Ssh(control))
            }
        };
        Ok((wire, PeerHandle::watch(lifecycle)))
    }
}

/// The bytes of one peer, split into the halves the client owns.
#[derive(Debug)]
pub struct Wire {
    source: Source,
    sink: Sink,
    diagnostics: Option<Diagnostics>,
}

/// Bytes that arrive from the peer.
#[derive(Debug)]
enum Source {
    /// A local process's stdout.
    Process(ChildStdout),
    /// The copying half of an SSH exec channel's stdout.
    Channel(tokio::io::DuplexStream),
}

/// Bytes that leave for the peer.
///
/// `Debug` is written by hand: the SSH writing half is a trait object, and a
/// trait object of a foreign trait carries no `Debug` with it.
enum Sink {
    /// A local process's stdin.
    Process(ChildStdin),
    /// The writing half of an SSH exec channel's stdin.
    Channel(Box<dyn AsyncWrite + Unpin + Send + 'static>),
}

impl std::fmt::Debug for Sink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Process(_) => f.write_str("Sink::Process(<stdin>)"),
            Self::Channel(_) => f.write_str("Sink::Channel(<writer>)"),
        }
    }
}

/// What the peer writes for a log rather than for the protocol.
#[derive(Debug)]
enum Diagnostics {
    /// A local process's stderr.
    Process(ChildStderr),
    /// The copying half of an SSH exec channel's stderr.
    Channel(tokio::io::DuplexStream),
}

impl Wire {
    /// The byte paths of a local process.
    fn of_process(source: ChildStdout, sink: ChildStdin, diagnostics: Option<ChildStderr>) -> Self {
        Self {
            source: Source::Process(source),
            sink: Sink::Process(sink),
            diagnostics: diagnostics.map(Diagnostics::Process),
        }
    }

    /// The byte paths of an SSH exec channel.
    fn of_channel(
        source: tokio::io::DuplexStream,
        sink: Box<dyn AsyncWrite + Unpin + Send + 'static>,
        diagnostics: Option<tokio::io::DuplexStream>,
    ) -> Self {
        Self {
            source: Source::Channel(source),
            sink: Sink::Channel(sink),
            diagnostics: diagnostics.map(Diagnostics::Channel),
        }
    }

    /// Starts the task that logs what the peer writes on stderr.
    ///
    /// pi logs to stderr, and a full pipe would stop it writing stdout: somebody
    /// has to read it. The drain belongs to the app rather than to the protocol
    /// client, which knows records and not streams.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime, like `tokio::spawn`.
    fn drain_diagnostics(mut self) -> Self {
        let Some(diagnostics) = self.diagnostics.take() else {
            return self;
        };
        tokio::spawn(async move {
            let mut reader: Box<dyn AsyncRead + Unpin + Send> = match diagnostics {
                Diagnostics::Process(stderr) => Box::new(stderr),
                Diagnostics::Channel(stream) => Box::new(stream),
            };
            let mut decoder = Decoder::new();
            let mut buffer = vec![0u8; READ_BUFFER];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => match decoder.push(&buffer[..count]) {
                        Ok(lines) => {
                            for line in lines {
                                tracing::debug!(target: "transport::stderr", line = %line, "pi wrote to stderr");
                            }
                        }
                        // A log line that is not a line: what the cap or the
                        // encoding refused is not worth stopping the drain for,
                        // and the reader is where pi is blocked until this runs.
                        Err(error) => {
                            tracing::debug!(target: "transport::stderr", %error, "a line of pi's log was dropped");
                            decoder.reset();
                        }
                    },
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) => {
                        tracing::debug!(target: "transport::stderr", %error, "pi's log ended in a failure");
                        break;
                    }
                }
            }
        });
        self
    }
}

impl Transport for Wire {
    type Tx = Sender;
    type Rx = Receiver;

    fn split(self) -> (Self::Tx, Self::Rx) {
        let wire = self.drain_diagnostics();
        (
            Sender { sink: wire.sink },
            Receiver {
                source: wire.source,
                decoder: Decoder::new(),
                ready: std::collections::VecDeque::new(),
            },
        )
    }
}

/// The writing half of a [`Wire`], in records.
#[derive(Debug)]
pub struct Sender {
    sink: Sink,
}

impl TransportSend for Sender {
    async fn send(&mut self, line: String) -> pi_rpc::error::Result<()> {
        // The client hands a record without its terminator, and framing is this
        // layer's job: one record is one LF-terminated line.
        let (head, tail) = (line.as_bytes(), b"\n".as_slice());
        let written = match &mut self.sink {
            Sink::Process(stdin) => {
                stdin.write_all(head).await?;
                stdin.write_all(tail).await?;
                stdin.flush().await
            }
            Sink::Channel(writer) => {
                writer.write_all(head).await?;
                writer.write_all(tail).await?;
                writer.flush().await
            }
        };
        Ok(written?)
    }

    async fn close(&mut self) -> pi_rpc::error::Result<()> {
        // The peer's stdin must reach EOF, and which half of that a transport
        // delivers differs: `AsyncWrite::shutdown` is a no-op for
        // `tokio::process::ChildStdin` (`ChildStdio::poll_shutdown` returns
        // `Ready(Ok(()))` without touching the pipe) while dropping the write
        // half is what gives it EOF - and the client drops this value once close
        // returns. An SSH channel is the other way around: dropping its writer
        // sends nothing, while `shutdown` sends the channel EOF that reaches the
        // remote pi as stdin EOF. Doing both covers each.
        match &mut self.sink {
            Sink::Process(stdin) => Ok(stdin.shutdown().await?),
            Sink::Channel(writer) => Ok(writer.shutdown().await?),
        }
    }
}

/// The reading half of a [`Wire`], in records.
#[derive(Debug)]
pub struct Receiver {
    source: Source,
    decoder: Decoder,
    /// Lines that arrived in the same chunk as the one returned before them.
    ready: std::collections::VecDeque<String>,
}

impl TransportRecv for Receiver {
    async fn recv(&mut self) -> pi_rpc::error::Result<Option<String>> {
        loop {
            if let Some(line) = self.ready.pop_front() {
                return Ok(Some(line));
            }
            let mut chunk = [0u8; READ_BUFFER];
            let read = match &mut self.source {
                Source::Process(stdout) => stdout.read(&mut chunk).await,
                Source::Channel(stream) => stream.read(&mut chunk).await,
            };
            match read {
                // A clean end: every byte the peer wrote arrived before it.
                Ok(0) => return Ok(None),
                Ok(count) => {
                    self.ready.extend(self.decoder.push(&chunk[..count])?);
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
}

/// The two halves of a peer's lifecycle, behind one enum so a caller that does
/// not care where pi runs can handle either.
#[derive(Debug)]
enum Behind {
    Local(local::LocalControl),
    Ssh(ssh::SshControl),
}

impl Lifecycle for Behind {
    async fn terminate(&mut self) -> Result<()> {
        match self {
            Self::Local(control) => control.terminate().await,
            Self::Ssh(control) => control.terminate().await,
        }
    }

    async fn wait(&mut self) -> Result<Termination> {
        match self {
            Self::Local(control) => control.wait().await,
            Self::Ssh(control) => control.wait().await,
        }
    }
}

/// What the watcher does when it is asked to.
#[derive(Debug)]
enum Watch {
    /// End the peer now.
    Terminate,
}

/// One hand on a peer's life: whether pi still runs, how to end it, and how to
/// wait for its end.
///
/// Cloning is another hand on the same peer. The watch itself runs in a task of
/// its own, which owns the lifecycle: a `wait` borrows what it waits on for as
/// long as the peer lives, so a caller that both waits and kills needs a second
/// hand reaching the first, and this channel is it.
#[derive(Debug, Clone)]
pub struct PeerHandle {
    commands: mpsc::Sender<Watch>,
    ended: watch::Receiver<Option<Termination>>,
}

impl PeerHandle {
    /// Starts the watch of one peer.
    fn watch(lifecycle: Behind) -> Self {
        let (commands, orders) = mpsc::channel(1);
        let (ended, ended_rx) = watch::channel(None);
        tokio::spawn(keep_watch(lifecycle, orders, ended));
        Self {
            commands,
            ended: ended_rx,
        }
    }

    /// Whether the peer still runs.
    pub fn is_alive(&self) -> bool {
        self.ended.borrow().is_none()
    }

    /// Asks the peer to stop, and answers once the order is in the watcher's
    /// hands. The end itself arrives through [`PeerHandle::wait`].
    pub async fn terminate(&self) {
        let _ = self.commands.send(Watch::Terminate).await;
    }

    /// Waits until the peer ends, however it ends.
    pub async fn wait(&self) -> Termination {
        let mut ended = self.ended.clone();
        loop {
            if let Some(termination) = *ended.borrow_and_update() {
                return termination;
            }
            if ended.changed().await.is_err() {
                // The watcher is gone, which is the watcher's own end.
                return Termination::Unknown;
            }
        }
    }
}

/// Watches one peer to its end, ending it when asked.
///
/// Both `wait` futures are dropped when the other branch of the select wins, and
/// both are cancel-safe: a cancelled `Child::wait` leaves the child unreaped and
/// a cancelled watch read loses nothing, so asking to terminate and then waiting
/// again is the same as having asked first.
async fn keep_watch(
    mut lifecycle: Behind,
    mut orders: mpsc::Receiver<Watch>,
    ended: watch::Sender<Option<Termination>>,
) {
    let termination = loop {
        tokio::select! {
            result = lifecycle.wait() => break result.unwrap_or(Termination::Unknown),
            order = orders.recv() => match order {
                Some(Watch::Terminate) => {
                    if let Err(error) = lifecycle.terminate().await {
                        tracing::debug!(%error, "asking the peer to stop failed");
                    }
                }
                // Every hand is gone; the peer is nobody's to end, so this
                // keeps waiting for it to end on its own.
                None => continue,
            },
        }
    };
    tracing::debug!(?termination, "the peer ended");
    ended.send_replace(Some(termination));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn how_a_peer_ended_travels_under_a_tag_of_its_own() {
        assert_eq!(
            serde_json::to_value(Termination::Exited {
                code: 3,
                success: false
            })
            .expect("an end serializes"),
            serde_json::json!({ "type": "exited", "code": 3, "success": false })
        );
        assert_eq!(
            serde_json::to_value(Termination::Signalled { signal: 9 }).expect("an end serializes"),
            serde_json::json!({ "type": "signalled", "signal": 9 })
        );
        assert_eq!(
            serde_json::to_value(Termination::Unknown).expect("an end serializes"),
            serde_json::json!({ "type": "unknown" })
        );
    }
}
