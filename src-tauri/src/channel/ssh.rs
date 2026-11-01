use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use russh::ChannelMsg;
use tokio::io::{AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::watch;

use crate::channel::{Channel, ExitStatus, Handle};

/// SIGKILL, under the number every POSIX system gives it.
const SIGKILL: i32 = 9;

/// Bytes a direction may buffer between the SSH channel and the client.
///
/// This is flow control, not storage: a full pipe stops the pump from reading
/// the channel, which stops the remote writer at the SSH window.
const PIPE_CAPACITY: usize = 64 * 1024;

/// SSH's extended-data code for a command's standard error.
const STDERR: u32 = 1;

/// A program in an SSH exec channel. The pump writes its exit status into the
/// watch.
pub struct SshProcess {
    write_half: russh::ChannelWriteHalf<russh::client::Msg>,
    exit: watch::Receiver<Option<ExitStatus>>,
    stop: Arc<tokio::sync::Notify>,
    killed: bool,
}

impl std::fmt::Debug for SshProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SshProcessHandler(<channel>)")
    }
}

/// A lifecycle failure on an SSH channel.
#[derive(Debug, thiserror::Error)]
pub enum SshProcessError {
    /// The channel ended without an exit message.
    #[error("the ssh channel ended without an exit status")]
    NoStatus,
}

/// Output and exit status received from an SSH channel before `ChannelMsg::Success`.
pub(crate) struct EarlyChannelOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: Option<ExitStatus>,
}

/// Takes a started exec channel: its streams become a [`Channel`], its end an
/// [`SshProcess`].
///
/// `early` holds what the machine sent before it confirmed the exec request; the
/// pump writes it out before reading the channel.
pub(crate) fn spawn(
    channel: russh::Channel<russh::client::Msg>,
    early: EarlyChannelOutput,
) -> (Channel, SshProcess) {
    let (read_half, write_half) = channel.split();

    let (stdout, stdout_rx) = tokio::io::duplex(PIPE_CAPACITY);
    let (stderr, stderr_rx) = tokio::io::duplex(PIPE_CAPACITY);
    let (exit, exit_rx) = watch::channel(None);
    let stop = Arc::new(tokio::sync::Notify::new());

    tokio::spawn(pump(
        read_half,
        stdout,
        stderr,
        early,
        exit,
        Arc::clone(&stop),
    ));

    let channel = Channel::new(
        Box::new(write_half.make_writer()),
        Box::new(stdout_rx),
        Box::new(stderr_rx),
    );
    let process = SshProcess {
        write_half,
        exit: exit_rx,
        stop,
        killed: false,
    };

    (channel, process)
}

/// How to end a wait that the channel answered without a status.
fn status_without_ended(killed: bool) -> anyhow::Result<ExitStatus> {
    if killed {
        return Ok(ExitStatus::signalled(SIGKILL));
    }
    Err(SshProcessError::NoStatus.into())
}

impl Handle for SshProcess {
    async fn wait(&mut self) -> anyhow::Result<ExitStatus> {
        let killed = self.killed;
        match self.exit.wait_for(Option::is_some).await {
            // `Unknown` is what the pump records when the channel closed without an
            // exit message, so it is not a status a host reported.
            Ok(ended) => match *ended {
                Some(ExitStatus::Unknown) | None => status_without_ended(killed),
                Some(status) => Ok(status),
            },
            Err(_) => status_without_ended(killed),
        }
    }

    fn try_wait(&mut self) -> anyhow::Result<Option<ExitStatus>> {
        let killed = self.killed;
        match *self.exit.borrow() {
            None => Ok(None),
            Some(ExitStatus::Unknown) => status_without_ended(killed).map(Some),
            Some(status) => Ok(Some(status)),
        }
    }

    async fn kill(&mut self) -> anyhow::Result<()> {
        // No CHANNEL_CLOSE on purpose: russh 0.63.3 forgets a channel its client
        // closed and then discards the server's exit message for it, so the pump
        // would never see the end. EOF keeps the entry; stopping the pump does
        // the rest.
        if let Err(error) = self.write_half.signal(russh::Sig::KILL).await {
            tracing::debug!(%error, "the host took no signal request");
        }
        if let Err(error) = self.write_half.eof().await {
            tracing::debug!(%error, "the host took no end-of-file");
        }
        self.killed = true;
        self.stop.notify_one();
        Ok(())
    }
}

/// Moves the channel's messages into the byte streams the client reads.
///
/// The exit status arrives as a channel message, not as a return value, so the
/// pump is its only source.
async fn pump(
    mut channel: russh::ChannelReadHalf,
    mut stdout: DuplexStream,
    mut stderr: DuplexStream,
    early: EarlyChannelOutput,
    exit: watch::Sender<Option<ExitStatus>>,
    stop: Arc<tokio::sync::Notify>,
) {
    // `Unknown` means the channel closed without an exit message; `wait` reads it
    // as the absence of a status, not as one.
    let mut ended = early.exit.unwrap_or(ExitStatus::Unknown);
    let mut dropped = 0usize;

    let copy = async {
        let mut stdout_open =
            early.stdout.is_empty() || stdout.write_all(&early.stdout).await.is_ok();
        dropped += early.stderr.len() - write_now(&mut stderr, &early.stderr);

        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if stdout_open && stdout.write_all(&data).await.is_err() {
                        stdout_open = false;
                    }
                }
                ChannelMsg::ExtendedData { data, ext: STDERR } => {
                    dropped += data.len() - write_now(&mut stderr, &data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    ended = ExitStatus::exited(exit_status as i32);
                }
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    match ExitStatus::try_from(signal_name) {
                        Ok(status) => ended = status,
                        Err(error) => {
                            tracing::debug!(%error, "the host reported a signal pie cannot name");
                        }
                    }
                }
                _ => {}
            }
        }
    };

    // Preempts both `channel.wait()` and a blocked `stdout.write_all()` once the
    // process is killed: after that nobody reads the streams.
    tokio::select! {
        () = copy => {}
        () = stop.notified() => {}
    }

    drop(stdout);
    drop(stderr);

    if dropped > 0 {
        tracing::debug!(
            target: "channel::ssh",
            bytes = dropped,
            "dropped stderr nobody was reading"
        );
    }
    let _ = exit.send_replace(Some(ended));
}

/// Writes as much of `data` as fits right now, never waiting, and reports how
/// much that was.
fn write_now(stream: &mut DuplexStream, data: &[u8]) -> usize {
    let mut context = Context::from_waker(Waker::noop());
    match Pin::new(stream).poll_write(&mut context, data) {
        Poll::Ready(Ok(written)) => written,
        Poll::Ready(Err(_)) | Poll::Pending => 0,
    }
}

impl TryFrom<russh::Sig> for ExitStatus {
    type Error = anyhow::Error;

    fn try_from(signal: russh::Sig) -> Result<Self, Self::Error> {
        let signal = match signal {
            russh::Sig::ABRT => 6,
            russh::Sig::ALRM => 14,
            russh::Sig::FPE => 8,
            russh::Sig::HUP => 1,
            russh::Sig::ILL => 4,
            russh::Sig::INT => 2,
            russh::Sig::KILL => SIGKILL,
            russh::Sig::PIPE => 13,
            russh::Sig::QUIT => 3,
            russh::Sig::SEGV => 11,
            russh::Sig::TERM => 15,
            russh::Sig::USR1 => 10,
            russh::Sig::Custom(name) => {
                anyhow::bail!("the host reported the signal `{name}`, which pie does not know")
            }
        };
        Ok(Self::signalled(signal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_named_signal_carries_its_number() {
        let table = [
            (russh::Sig::HUP, 1),
            (russh::Sig::INT, 2),
            (russh::Sig::QUIT, 3),
            (russh::Sig::ILL, 4),
            (russh::Sig::ABRT, 6),
            (russh::Sig::FPE, 8),
            (russh::Sig::KILL, 9),
            (russh::Sig::USR1, 10),
            (russh::Sig::SEGV, 11),
            (russh::Sig::PIPE, 13),
            (russh::Sig::ALRM, 14),
            (russh::Sig::TERM, 15),
        ];

        for (signal, number) in table {
            let status = ExitStatus::try_from(signal).expect("a known signal becomes a status");
            assert_eq!(status.code(), None);
            assert_eq!(status.signal(), Some(number));
            assert!(status.is_signalled());
        }
    }

    #[test]
    fn a_signal_pie_cannot_name_is_a_failure_that_names_it() {
        let error = ExitStatus::try_from(russh::Sig::Custom("FOO".to_string()))
            .expect_err("an unknown signal is refused");

        assert!(
            error.to_string().contains("FOO"),
            "the failure names the signal: {error}"
        );
    }

    #[test]
    fn a_killed_command_that_left_no_status_is_reported_by_sigkill() {
        let status = status_without_ended(true).expect("a kill is not a failure");

        assert_eq!(status.code(), None);
        assert_eq!(status.signal(), Some(9));
    }

    #[test]
    fn a_command_that_left_no_status_is_a_failure() {
        let error = status_without_ended(false).expect_err("no status is a failure");

        assert!(
            error.to_string().contains("without an exit status"),
            "the failure says what is missing: {error}"
        );
    }
}
