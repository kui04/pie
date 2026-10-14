//! One started program: its bytes, and its life.
//!
//! A program runs on a host: a child process of this machine, or in an exec
//! channel of an SSH session. This module is the byte path and nothing else. It
//! does not know which host it is on, what its records say, or which session
//! owns it. [`host`](crate::host) starts a channel; [`pi_rpc`] reads one.
//!
//! [`Channel`] is the app's whole word for a started program. It implements
//! [`pi_rpc::transport::Transport`], so the protocol client speaks over it, and
//! [`Channel::handle`] is a second hand on the same program's life - whether it
//! still runs, how to end it, and how to wait for its end. The handle is taken
//! before the channel is handed to the client, because `split` consumes the
//! channel.
//!
//! Two rules hold for every channel:
//!
//! - **Somebody reads the program's standard error.** Pie logs it, so a program
//!   that writes enough of it never blocks on a full pipe, which would stop its
//!   standard output too. The drain starts with the channel.
//! - **The channel is created by [`host`](crate::host) and by nothing else.** It
//!   is the one place that knows which machine it reached, and the one place
//!   that knows how a channel is opened over SSH.

mod error;
pub(crate) mod ssh;
mod stdio;

pub use error::{Error, Result};
pub use ssh::Exec;
pub use stdio::Program;

use std::collections::VecDeque;
use std::io::ErrorKind;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use pi_rpc::frame::Decoder;
use pi_rpc::transport::{Transport, TransportRecv, TransportSend};

/// Bytes read from the program per syscall. Records are assembled across chunks,
/// so this only tunes throughput.
const READ_BUFFER: usize = 32 * 1024;

/// The largest record pie frames from pi: one answer holds a whole conversation.
pub(crate) const MAX_LINE: usize = 128 * 1024 * 1024;

/// How a program stopped.
///
/// This is not a record of pi. No form of it appears in `rpc-types.ts`: it is
/// what pie observed about the process, or the channel, that ran a program. The
/// app sends it unchanged as the end of a session, so it carries a `type` tag
/// and snake_case values like the rest of the app's payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Termination {
    /// The program exited with this status.
    Exited {
        /// Exit code.
        code: i32,
        /// Whether the code counts as success.
        success: bool,
    },
    /// The program was killed by this signal.
    Signalled {
        /// Signal number.
        signal: i32,
    },
    /// The program ended without a status pie can read.
    Unknown,
}

/// One started program: a byte path, and the life behind it.
///
/// `Debug` is written by hand: the byte paths are trait objects, and a trait
/// object of a foreign trait carries no `Debug` with it.
pub struct Channel {
    source: Box<dyn AsyncRead + Unpin + Send + 'static>,
    sink: Box<dyn AsyncWrite + Unpin + Send + 'static>,
    handle: Handle,
}

impl Channel {
    /// Assembles a channel from its paths, its diagnostics and its life.
    ///
    /// The standard error is read from here on, in a task of its own, for the
    /// reason in the module documentation.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime, like `tokio::spawn`.
    pub(crate) fn of(
        source: Box<dyn AsyncRead + Unpin + Send + 'static>,
        sink: Box<dyn AsyncWrite + Unpin + Send + 'static>,
        diagnostics: Box<dyn AsyncRead + Unpin + Send + 'static>,
        behind: Behind,
    ) -> Self {
        tokio::spawn(drain(diagnostics));
        Self {
            source,
            sink,
            handle: Handle::watch(behind),
        }
    }

    /// One hand on the life of this program.
    ///
    /// A clone is another hand on the same program, not a copy of it. Take one
    /// before the channel goes to the protocol client: `split` consumes the
    /// channel, and the client never sees a life.
    pub fn handle(&self) -> Handle {
        self.handle.clone()
    }
}

impl std::fmt::Debug for Channel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Channel")
            .field("handle", &self.handle)
            .finish_non_exhaustive()
    }
}

impl Transport for Channel {
    type Tx = Sender;
    type Rx = Receiver;

    fn split(self) -> (Self::Tx, Self::Rx) {
        (
            Sender { sink: self.sink },
            Receiver {
                source: self.source,
                decoder: Decoder::with_max_line(MAX_LINE),
                ready: VecDeque::new(),
            },
        )
    }
}

/// Reads a program's standard error to its end, one line at a time, into the log.
///
/// A program logs to standard error, and a full pipe would stop it writing
/// standard output: somebody has to read it. The drain belongs to the app rather
/// than to the protocol client, which knows records and not streams.
///
/// # Panics
///
/// Never. A line that the cap or the encoding refuses is dropped, and a read
/// that fails ends the drain.
async fn drain(mut reader: Box<dyn AsyncRead + Unpin + Send + 'static>) {
    let mut decoder = Decoder::with_max_line(MAX_LINE);
    let mut buffer = vec![0u8; READ_BUFFER];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(count) => match decoder.push(&buffer[..count]) {
                Ok(lines) => {
                    for line in lines {
                        tracing::debug!(target: "channel::stderr", line = %line, "the program wrote to stderr");
                    }
                }
                // A log line that is not a line: what the cap or the encoding
                // refused is not worth stopping the drain for, and the reader is
                // where the program is blocked until this runs.
                Err(error) => {
                    tracing::debug!(target: "channel::stderr", %error, "a line of the program's log was dropped");
                    decoder.reset();
                }
            },
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => {
                tracing::debug!(target: "channel::stderr", %error, "the program's log ended in a failure");
                break;
            }
        }
    }
}

/// The writing half of a [`Channel`], in records.
pub struct Sender {
    sink: Box<dyn AsyncWrite + Unpin + Send + 'static>,
}

impl std::fmt::Debug for Sender {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Sender").finish_non_exhaustive()
    }
}

impl TransportSend for Sender {
    async fn send(&mut self, line: String) -> pi_rpc::error::Result<()> {
        // The client hands a record without its terminator, and framing is this
        // layer's job: one record is one LF-terminated line.
        let (head, tail) = (line.as_bytes(), b"\n".as_slice());
        self.sink.write_all(head).await?;
        self.sink.write_all(tail).await?;
        self.sink.flush().await?;
        Ok(())
    }

    async fn close(&mut self) -> pi_rpc::error::Result<()> {
        // The program's standard input must reach EOF, and which half of that a
        // path delivers differs: `AsyncWrite::shutdown` is a no-op for
        // `tokio::process::ChildStdin` (`ChildStdio::poll_shutdown` returns
        // `Ready(Ok(()))` without touching the pipe) while dropping the write
        // half is what gives it EOF - and the client drops this value once close
        // returns. An SSH channel is the other way around: dropping its writer
        // sends nothing, while `shutdown` sends the channel EOF that reaches the
        // remote program as standard-input EOF. Doing both covers each.
        Ok(self.sink.shutdown().await?)
    }
}

/// The reading half of a [`Channel`], in records.
pub struct Receiver {
    source: Box<dyn AsyncRead + Unpin + Send + 'static>,
    decoder: Decoder,
    /// Lines that arrived in the same chunk as the one returned before them.
    ready: VecDeque<String>,
}

impl std::fmt::Debug for Receiver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Receiver")
            .field("ready", &self.ready.len())
            .finish_non_exhaustive()
    }
}

impl TransportRecv for Receiver {
    async fn recv(&mut self) -> pi_rpc::error::Result<Option<String>> {
        loop {
            if let Some(line) = self.ready.pop_front() {
                return Ok(Some(line));
            }
            let mut chunk = [0u8; READ_BUFFER];
            match self.source.read(&mut chunk).await {
                // A clean end: every byte wrote arrived before it.
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

/// The two halves of a program's lifecycle, behind one enum so a caller that does
/// not care where it runs can handle either.
///
/// Contract: once [`Behind::wait`] resolves, the program's bytes reached their end
/// too, so a reader has already seen everything it wrote.
pub(crate) enum Behind {
    Stdio(stdio::Control),
    Ssh(ssh::Control),
}

impl std::fmt::Debug for Behind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stdio(control) => formatter.debug_tuple("Behind::Stdio").field(control).finish(),
            Self::Ssh(control) => formatter.debug_tuple("Behind::Ssh").field(control).finish(),
        }
    }
}

impl Behind {
    /// Ends the program. For a process: kill and reap.
    async fn terminate(&mut self) -> Result<()> {
        match self {
            Self::Stdio(control) => control.terminate().await,
            Self::Ssh(control) => control.terminate().await,
        }
    }

    async fn wait(&mut self) -> Result<Termination> {
        match self {
            Self::Stdio(control) => control.wait().await,
            Self::Ssh(control) => control.wait().await,
        }
    }
}

/// One hand on a program's life: whether it still runs, how to end it, and how to
/// wait for its end.
///
/// Cloning is another hand on the same program. The watch itself runs in a task
/// of its own, which owns the lifecycle: a `wait` borrows what it waits on for as
/// long as the program lives, so a caller that both waits and kills needs a
/// second hand reaching the first, and this channel is it.
#[derive(Debug, Clone)]
pub struct Handle {
    commands: mpsc::Sender<()>,
    ended: watch::Receiver<Option<Termination>>,
}

impl Handle {
    /// Starts the watch of one program.
    fn watch(behind: Behind) -> Self {
        let (commands, orders) = mpsc::channel(1);
        let (ended, ended_rx) = watch::channel(None);
        tokio::spawn(keep_watch(behind, orders, ended));
        Self {
            commands,
            ended: ended_rx,
        }
    }

    /// Whether the program still runs.
    pub fn is_alive(&self) -> bool {
        self.ended.borrow().is_none()
    }

    /// Asks the program to stop, and answers once the order is in the watcher's
    /// hands. The end itself arrives through [`Handle::wait`].
    pub async fn terminate(&self) {
        let _ = self.commands.send(()).await;
    }

    /// Waits until the program ends, however it ends.
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

/// Watches one program to its end, ending it when asked.
///
/// Both `wait` futures are dropped when the other branch of the select wins, and
/// both are cancel-safe: a cancelled `Child::wait` leaves the child unreaped and
/// a cancelled watch read loses nothing, so asking to terminate and then waiting
/// again is the same as having asked first.
async fn keep_watch(mut behind: Behind, mut orders: mpsc::Receiver<()>, ended: watch::Sender<Option<Termination>>) {
    let termination = loop {
        tokio::select! {
            result = behind.wait() => break result.unwrap_or(Termination::Unknown),
            order = orders.recv() => match order {
                Some(()) => {
                    if let Err(error) = behind.terminate().await {
                        tracing::debug!(%error, "asking the program to stop failed");
                    }
                }
                // Every hand is gone; the program is nobody's to end, so this
                // keeps waiting for it to end on its own.
                None => continue,
            },
        }
    };
    tracing::debug!(?termination, "the program ended");
    ended.send_replace(Some(termination));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn how_a_program_ended_travels_under_a_tag_of_its_own() {
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

    /// The 17.8 MB session that failed this way arrived past the frame's own 16 MiB bound.
    #[test]
    fn frames_a_record_larger_than_the_frame_default() {
        let entry = "x".repeat(17 * 1024 * 1024);
        let line = format!("{{\"entries\":[\"{entry}\"],\"leafId\":null}}");
        let record = format!("{line}\n");
        let mut decoder = Decoder::with_max_line(MAX_LINE);
        let mut lines = Vec::new();
        // It arrives as a stream arrives: in chunks, with the line feed last.
        for chunk in record.as_bytes().chunks(64 * 1024) {
            lines.extend(decoder.push(chunk).expect("the channel takes the record"));
        }
        assert_eq!(lines, vec![line]);
    }

    /// The values that cross a command are held across `.await` points in the
    /// command futures, so each must be `Send`; the two shared handles are read
    /// from several tasks at once, so they must be `Sync` as well.
    #[test]
    fn the_types_that_cross_a_command_are_send() {
        const fn assert_send<T: Send>() {}
        const fn assert_send_sync<T: Send + Sync>() {}
        assert_send::<Channel>();
        assert_send::<Sender>();
        assert_send::<Receiver>();
        assert_send_sync::<Handle>();
        assert_send_sync::<Termination>();
    }
}
