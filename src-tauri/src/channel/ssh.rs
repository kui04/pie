//! A started program as an exec channel of a Shell session.
//!
//! The SSH layer reaches a machine in [`host::ssh`](crate::host::ssh); this
//! module owns what happens after a command is running in a channel of that
//! session: the two byte streams, the exit status, and the way to end the
//! command. It knows `russh` and nothing about which machine the session
//! reaches - a channel that is never named cannot be reached by a wrong name.
//!
//! stdout and stderr arrive as separate SSH messages on one channel while the
//! app wants two streams, so a pump copies each into a pipe of its own. The
//! pump is also the only source of the exit status: SSH reports it as a channel
//! message, not as a return value.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use russh::{Channel as SshChannel, ChannelMsg, ChannelWriteHalf, Sig};
use tokio::io::{AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::{Notify, watch};

use super::{Result, Termination};

/// Bytes a direction may buffer between the SSH channel and the client.
///
/// This is flow control, not storage: a full pipe stops the pump from reading
/// the channel, which stops the remote writer at the SSH window.
const PIPE_CAPACITY: usize = 64 * 1024;

/// SSH's extended-data code for a command's standard error.
const STDERR: u32 = 1;

/// An SSH exec channel with its command running in it.
pub struct Exec {
    channel: SshChannel<russh::client::Msg>,
    endpoint: String,
    command: String,
    /// Data that arrived with (or before) the server's reply to the exec
    /// request, kept so no byte of the command's output can be lost.
    early: (Vec<u8>, Vec<u8>),
}

impl std::fmt::Debug for Exec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Exec")
            .field("endpoint", &self.endpoint)
            .field("command", &self.command)
            .finish_non_exhaustive()
    }
}

/// The copying pipes of an SSH exec channel.
///
/// Named rather than a tuple so the reading side of a one-shot capture and the
/// record side of [`Exec::into_channel`] take them the same way.
pub(crate) struct Pipes {
    /// The command's standard output, copied out of the channel.
    pub(crate) stdout: DuplexStream,
    /// The command's standard input: `russh`'s opaque writer, whose
    /// `poll_shutdown` sends the channel EOF.
    pub(crate) stdin: Box<dyn tokio::io::AsyncWrite + Unpin + Send + 'static>,
    /// The command's standard error, copied out of the channel.
    pub(crate) stderr: DuplexStream,
}

impl Exec {
    /// The exec channel a session opened, with its command running.
    pub(crate) fn new(
        channel: SshChannel<russh::client::Msg>,
        endpoint: String,
        command: String,
        early: (Vec<u8>, Vec<u8>),
    ) -> Self {
        Self {
            channel,
            endpoint,
            command,
            early,
        }
    }

    /// Takes the channel into the record path of the protocol client.
    ///
    /// The standard error goes to the log, which is what a protocol channel
    /// wants: nobody answers it, and an unread pipe would stop the remote
    /// program writing. A one-shot command that pie captures whole reads those
    /// bytes itself instead, from the pipes the exec channel is taken apart into.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime, like the channel's own assembly.
    pub fn into_channel(self) -> super::Channel {
        let (pipes, control) = self.into_pipes();
        super::Channel::of(
            Box::new(pipes.stdout),
            pipes.stdin,
            Box::new(pipes.stderr),
            super::Behind::Ssh(control),
        )
    }

    /// Takes the channel apart: the copying pipes, and the lifecycle behind them.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime: the copy runs in a task of its own.
    pub(crate) fn into_pipes(self) -> (Pipes, Control) {
        let Self {
            channel,
            endpoint,
            command: _,
            early,
        } = self;
        let (read_half, write_half) = channel.split();

        let (stdout_tx, stdout_rx) = tokio::io::duplex(PIPE_CAPACITY);
        let (stderr_tx, stderr_rx) = tokio::io::duplex(PIPE_CAPACITY);
        let (exit_tx, exit_rx) = watch::channel(None);
        let stop = Arc::new(Notify::new());
        tokio::spawn(pump(read_half, stdout_tx, stderr_tx, early, exit_tx, Arc::clone(&stop)));

        (
            Pipes {
                stdout: stdout_rx,
                stdin: Box::new(write_half.make_writer()),
                stderr: stderr_rx,
            },
            Control {
                endpoint,
                write_half,
                exit: exit_rx,
                stop,
                killed: false,
            },
        )
    }
}

/// The running command behind an [`Exec`].
pub(crate) struct Control {
    endpoint: String,
    write_half: ChannelWriteHalf<russh::client::Msg>,
    exit: watch::Receiver<Option<Termination>>,
    /// Tells the pump to stop copying: after a terminate there is nobody left
    /// to copy for, and a quiet command never gives the copy a reason to end.
    stop: Arc<Notify>,
    /// Whether this control asked the command to die, which decides what
    /// `wait` reports when the host's own status never arrives.
    killed: bool,
}

impl std::fmt::Debug for Control {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Control")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl Control {
    /// Asks the machine to end the command, with the signal request sshd turns
    /// into a kill of the process group, and EOF alongside it.
    ///
    /// No CHANNEL_CLOSE is sent, on purpose. russh 0.63.3 drops a channel from
    /// its own bookkeeping when the client closes it (`session.rs` `close`) and
    /// then discards the server's close and exit-status over the missing entry
    /// (`client/encrypted.rs`, the established-channel check), so the stream the
    /// pump reads would never end and `wait` would hang on a command that prints
    /// nothing. EOF keeps the entry; stopping the pump does the rest. The rest
    /// of the session - other sessions' pi and the app's sftp scans - rides on
    /// untouched.
    pub(crate) async fn terminate(&mut self) -> Result<()> {
        tracing::debug!(endpoint = %self.endpoint, "killing the remote command");
        if let Err(error) = self.write_half.signal(Sig::KILL).await {
            tracing::debug!(endpoint = %self.endpoint, %error, "the host took no signal request");
        }
        let _ = self.write_half.eof().await;
        self.killed = true;
        self.stop.notify_one();
        Ok(())
    }

    /// Waits for the command to end and reports how it ended.
    pub(crate) async fn wait(&mut self) -> Result<Termination> {
        loop {
            let reported = *self.exit.borrow_and_update();
            if let Some(termination) = reported {
                return Ok(self.reported(termination));
            }
            if self.exit.changed().await.is_err() {
                // The pump is gone without an exit status: the session died.
                return Ok(self.reported(Termination::Unknown));
            }
        }
    }

    /// What the command ending reports after this control asked it to die.
    ///
    /// The pump stops the moment terminate says so, so the host's own status
    /// rarely arrives - and "unknown" is the one answer a caller cannot act on,
    /// while what happened to the process is known: SIGKILL (the signal request
    /// sshd turns into `killpg`). A local process answers the same operation
    /// with `Signalled { signal: 9 }`, and two channels must not tell the app
    /// different stories about one kill.
    fn reported(&self, termination: Termination) -> Termination {
        match termination {
            Termination::Unknown if self.killed => Termination::Signalled { signal: 9 },
            known => known,
        }
    }
}

/// Moves the channel's messages into the byte streams the client reads.
///
/// The channel's exit status is the only source for [`Control::wait`], which is
/// why it is collected here.
async fn pump(
    mut channel: russh::ChannelReadHalf,
    mut stdout: DuplexStream,
    mut stderr: DuplexStream,
    early: (Vec<u8>, Vec<u8>),
    exit: watch::Sender<Option<Termination>>,
    stop: Arc<Notify>,
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

    // The stop notice is terminate's: after it there is nobody to copy for, and
    // a command that prints nothing never gives this loop a reason of its own to
    // end.
    while let Some(message) = tokio::select! {
        message = channel.wait() => message,
        _ = stop.notified() => None,
    } {
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
            target: "channel::ssh",
            bytes = dropped_stderr,
            "dropped stderr nobody was reading"
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
