//! A started program as an exec channel of an SSH session.
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

use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, Waker},
};

use russh::{Channel as SshChannel, ChannelMsg, ChannelWriteHalf, Sig};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt, DuplexStream},
    sync::{Notify, watch},
};

use super::{Channel, Lifecycle, Termination};

/// Bytes a direction may buffer between the SSH channel and the client.
///
/// This is flow control, not storage: a full pipe stops the pump from reading
/// the channel, which stops the remote writer at the SSH window.
const PIPE_CAPACITY: usize = 64 * 1024;

/// SSH's extended-data code for a command's standard error.
const STDERR: u32 = 1;

/// Assembles a protocol channel from an SSH exec channel.
pub(super) fn from_channel(
    channel: SshChannel<russh::client::Msg>,
    endpoint: String,
    early_stdout: Vec<u8>,
    early_stderr: Vec<u8>,
) -> Channel {
    let (read_half, write_half) = channel.split();

    let (stdout_tx, stdout_rx) = tokio::io::duplex(PIPE_CAPACITY);
    let (stderr_tx, stderr_rx) = tokio::io::duplex(PIPE_CAPACITY);
    let (exit_tx, exit_rx) = watch::channel(None);
    let stop = Arc::new(Notify::new());

    tokio::spawn(pump(
        read_half,
        stdout_tx,
        stderr_tx,
        early_stdout,
        early_stderr,
        exit_tx,
        Arc::clone(&stop),
    ));

    let stdin = Box::new(write_half.make_writer());
    let remote = Remote {
        endpoint,
        write_half,
        exit_rx,
        stop,
        killed: false,
    };

    Channel::new(stdout_rx, stdin, stderr_rx, Box::new(remote))
}

/// The running command behind an SSH channel.
struct Remote {
    endpoint: String,
    write_half: ChannelWriteHalf<russh::client::Msg>,
    exit_rx: watch::Receiver<Option<Termination>>,
    /// Tells the pump to stop copying: after a terminate there is nobody left
    /// to copy for, and a quiet command never gives the copy a reason to end.
    stop: Arc<Notify>,
    /// Whether this control asked the command to die, which decides what
    /// `wait` reports when the host's own status never arrives.
    killed: bool,
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Remote")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl Lifecycle for Remote {
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
    async fn terminate(&mut self) {
        tracing::debug!(endpoint = %self.endpoint, "killing the remote command");
        if let Err(error) = self.write_half.signal(Sig::KILL).await {
            tracing::debug!(endpoint = %self.endpoint, %error, "the host took no signal request");
        }
        let _ = self.write_half.eof().await;
        self.killed = true;
        self.stop.notify_one();
    }

    /// Waits for the command to end and reports how it ended.
    async fn wait(&mut self) -> Termination {
        let termination = match self.exit_rx.wait_for(Option::is_some).await {
            Ok(guard) => guard.unwrap_or(Termination::Unknown),
            Err(_) => {
                tracing::warn!(
                    endpoint = %self.endpoint,
                    "the command's channel ended without a status"
                );
                Termination::Unknown
            }
        };
        self.resolve_termination(termination)
    }
}

impl Remote {
    /// What the command ending reports after this control asked it to die.
    fn resolve_termination(&self, termination: Termination) -> Termination {
        match termination {
            Termination::Unknown if self.killed => Termination::from(Sig::KILL),
            known => known,
        }
    }
}

/// Moves the channel's messages into the byte streams the client reads.
///
/// The channel's exit status is the only source for [`Remote::wait`], which is
/// why it is collected here.
async fn pump(
    mut channel: russh::ChannelReadHalf,
    mut stdout: DuplexStream,
    mut stderr: DuplexStream,
    early_stdout: Vec<u8>,
    early_stderr: Vec<u8>,
    exit_tx: watch::Sender<Option<Termination>>,
    stop: Arc<Notify>,
) {
    let mut termination = Termination::Unknown;
    let mut dropped_stderr = 0usize;

    let copy_loop = async {
        if !early_stdout.is_empty() && stdout.write_all(&early_stdout).await.is_err() {
            return;
        }
        dropped_stderr += early_stderr.len() - write_now(&mut stderr, &early_stderr);

        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if stdout.write_all(&data).await.is_err() {
                        break;
                    }
                }
                ChannelMsg::ExtendedData { data, ext: STDERR } => {
                    dropped_stderr += data.len() - write_now(&mut stderr, &data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    termination = Termination::Exited {
                        code: exit_status as i32,
                        success: exit_status == 0,
                    };
                }
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    termination = Termination::from(signal_name);
                }
                _ => {}
            }
        }
    };

    // Preempts both `channel.wait()` and a blocked `stdout.write_all()` when
    // `Remote::terminate` notifies `stop`.
    tokio::select! {
        () = copy_loop => {}
        () = stop.notified() => {}
    }

    drop(stdout);
    drop(stderr);

    if dropped_stderr > 0 {
        tracing::debug!(
            target: "channel::ssh",
            bytes = dropped_stderr,
            "dropped stderr nobody was reading"
        );
    }
    let _ = exit_tx.send_replace(Some(termination));
}

/// Writes as much of `data` as fits right now, never waiting, and reports how
/// much that was.
fn write_now(stream: &mut DuplexStream, data: &[u8]) -> usize {
    let mut cx = Context::from_waker(Waker::noop());
    match Pin::new(stream).poll_write(&mut cx, data) {
        Poll::Ready(Ok(written)) => written,
        Poll::Ready(Err(_)) | Poll::Pending => 0,
    }
}

impl From<Sig> for Termination {
    fn from(signal: Sig) -> Self {
        let signal = match signal {
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
            Sig::Custom(_) => return Self::Unknown,
        };
        Self::Signalled { signal }
    }
}
