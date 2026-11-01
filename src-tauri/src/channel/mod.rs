//! The byte streams of one started program, and its exit.
//!
//! stderr never enters the record stream: `split` drains it to the log.

pub(crate) mod local;
pub(crate) mod ssh;

use std::collections::VecDeque;
use std::fmt::{self, Debug};
use std::io::ErrorKind;

use enum_dispatch::enum_dispatch;
use pi_rpc::frame::Decoder as PiRpcDecoder;
use pi_rpc::transport::{Transport, TransportRecv, TransportSend};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub type BoxedWriter = Box<dyn AsyncWrite + Unpin + Send + 'static>;
pub type BoxedReader = Box<dyn AsyncRead + Unpin + Send + 'static>;

/// The largest record pie frames from pi. One `get_entries` answer holds a whole
/// conversation.
pub const MAX_LINE: usize = 128 * 1024 * 1024;

/// Bytes read from a program per syscall. Records are assembled across chunks,
/// so this only tunes throughput.
const READ_BUFFER: usize = 32 * 1024;

/// How one program ended.
///
/// A signalled program has no exit code, and a machine that reports nothing has
/// neither, so neither fact is a number with a flag beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExitStatus {
    /// The program chose to exit with this code.
    Exited {
        /// The code the program exited with.
        code: i32,
    },
    /// A signal ended the program.
    Signalled {
        /// The signal number, as POSIX numbers it.
        signal: i32,
    },
    /// The machine said the program ended and gave no status.
    Unknown,
}

impl ExitStatus {
    pub fn exited(code: i32) -> Self {
        Self::Exited { code }
    }

    pub fn signalled(signal: i32) -> Self {
        Self::Signalled { signal }
    }

    pub fn unknown() -> Self {
        Self::Unknown
    }

    pub fn is_success(&self) -> bool {
        matches!(self, Self::Exited { code: 0 })
    }

    pub fn is_signalled(&self) -> bool {
        matches!(self, Self::Signalled { .. })
    }

    /// The exit code, when the program chose one.
    pub fn code(&self) -> Option<i32> {
        match self {
            Self::Exited { code } => Some(*code),
            Self::Signalled { .. } | Self::Unknown => None,
        }
    }

    /// The signal number, when a signal ended the program.
    pub fn signal(&self) -> Option<i32> {
        match self {
            Self::Signalled { signal } => Some(*signal),
            Self::Exited { .. } | Self::Unknown => None,
        }
    }
}

impl std::fmt::Display for ExitStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exited { code } => write!(formatter, "exited with code {code}"),
            Self::Signalled { signal } => write!(formatter, "ended by signal {signal}"),
            Self::Unknown => formatter.write_str("ended without a status"),
        }
    }
}

/// The byte path of one started program.
pub struct Channel {
    pub stdin: BoxedWriter,
    pub stdout: BoxedReader,
    pub stderr: BoxedReader,
}

impl fmt::Debug for Channel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Channel(<streams>)")
    }
}

impl Channel {
    /// Hand it to the client (`split`) promptly: the stderr drain starts there.
    pub(crate) fn new(stdin: BoxedWriter, stdout: BoxedReader, stderr: BoxedReader) -> Self {
        Self {
            stdin,
            stdout,
            stderr,
        }
    }
}

impl Transport for Channel {
    type Tx = PiRpcSender;
    type Rx = PiRpcReceiver;

    fn split(self) -> (Self::Tx, Self::Rx) {
        tokio::spawn(drain_stderr(self.stderr));

        (
            PiRpcSender(self.stdin),
            PiRpcReceiver {
                stdout: self.stdout,
                decoder: PiRpcDecoder::with_max_line(MAX_LINE),
                lines: VecDeque::new(),
                buffer: vec![0u8; READ_BUFFER].into_boxed_slice(),
            },
        )
    }
}

/// Reads a program's standard error to its end, one line at a time, into the log.
///
/// A full stderr pipe would stop the program writing stdout, so somebody reads
/// it. A line the cap or the encoding refuses is dropped, and a read that fails
/// ends the drain: neither is a reason to end the program.
async fn drain_stderr(mut stderr: BoxedReader) {
    let mut decoder = PiRpcDecoder::with_max_line(MAX_LINE);
    let mut buffer = vec![0u8; READ_BUFFER].into_boxed_slice();

    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => match decoder.push(&buffer[..read]) {
                Ok(lines) => {
                    for line in lines {
                        tracing::debug!(target: "channel::stderr", %line, "the program wrote to stderr");
                    }
                }
                Err(error) => {
                    tracing::debug!(target: "channel::stderr", %error, "a line of the program's log was dropped");
                    decoder.reset();
                }
            },
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => {
                tracing::debug!(target: "channel::stderr", %error, "the program's log ended in a failure");
                break;
            }
        }
    }
}

/// One record per call, without the LF terminator.
pub struct PiRpcSender(BoxedWriter);

impl fmt::Debug for PiRpcSender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PiRpcSender(<writer>)")
    }
}

impl TransportSend for PiRpcSender {
    async fn send(&mut self, mut line: String) -> pi_rpc::error::Result<()> {
        line.push('\n');
        self.0.write_all(line.as_bytes()).await?;
        self.0.flush().await?;
        Ok(())
    }

    async fn close(&mut self) -> pi_rpc::error::Result<()> {
        // A child's stdin sees EOF on drop and an SSH writer sends EOF only on
        // shutdown; shutting down does both, so neither path is left half-closed.
        self.0.shutdown().await?;
        Ok(())
    }
}

pub struct PiRpcReceiver {
    stdout: BoxedReader,
    decoder: PiRpcDecoder,
    lines: VecDeque<String>,
    buffer: Box<[u8]>,
}

impl fmt::Debug for PiRpcReceiver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiRpcReceiver")
            .field("lines", &self.lines.len())
            .finish_non_exhaustive()
    }
}

impl TransportRecv for PiRpcReceiver {
    async fn recv(&mut self) -> pi_rpc::error::Result<Option<String>> {
        loop {
            if let Some(line) = self.lines.pop_front() {
                return Ok(Some(line));
            }
            match self.stdout.read(&mut self.buffer).await {
                Ok(0) => return Ok(None),
                Ok(read) => self.lines.extend(self.decoder.push(&self.buffer[..read])?),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
}

/// The life of one started program.
#[enum_dispatch]
pub trait Handle: Sized + Send + Debug {
    /// Waits for the program to exit completely, and answers with the status it exited with.
    ///
    /// A second call answers the same status: the end of a program does not change.
    async fn wait(&mut self) -> anyhow::Result<ExitStatus>;

    /// Answers the status of the program when it already exited.
    ///
    /// This call does not block: `None` says the program still runs.
    fn try_wait(&mut self) -> anyhow::Result<Option<ExitStatus>>;

    /// Forces the program to exit.
    ///
    /// This call does not wait; [wait](Self::wait) collects the status.
    async fn kill(&mut self) -> anyhow::Result<()>;
}

/// One started program of the two kinds. The host builds it; the session owns it.
#[enum_dispatch(Handle)]
pub enum Process {
    Local(local::LocalProcess),
    Ssh(ssh::SshProcess),
}

impl std::fmt::Debug for Process {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(_) => formatter.write_str("Process::Local"),
            Self::Ssh(_) => formatter.write_str("Process::Ssh"),
        }
    }
}

/// The enum must satisfy the trait it lists on `#[enum_dispatch]`.
fn assert_process_impls()
where
    Process: Handle,
{
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use pi_rpc::error::ErrorKind;
    use tokio::io::{DuplexStream, ReadHalf};

    use super::*;

    /// How long a test waits on the channel before it calls it stuck.
    const PATIENCE: Duration = Duration::from_secs(5);

    /// A channel under test, and the ends the started program holds.
    struct Wire {
        channel: Channel,
        /// What the program writes to its standard output.
        stdout: DuplexStream,
        /// What the program reads from its standard input.
        stdin: DuplexStream,
        /// What the program writes to its standard error.
        stderr: DuplexStream,
    }

    impl Wire {
        fn new() -> Self {
            let (stdout, to_channel) = tokio::io::duplex(1024);
            let (from_channel, stdin) = tokio::io::duplex(1024);
            let (stderr, to_drain) = tokio::io::duplex(1024);
            Self {
                channel: Channel::new(
                    Box::new(from_channel),
                    Box::new(to_channel),
                    Box::new(to_drain),
                ),
                stdout,
                stdin,
                stderr,
            }
        }
    }

    /// The next record, or `None` at a clean end.
    async fn recv(receiver: &mut PiRpcReceiver) -> Option<String> {
        tokio::time::timeout(PATIENCE, receiver.recv())
            .await
            .expect("the channel answered in time")
            .expect("the channel took the record")
    }

    /// The next record, or the failure the channel reported.
    async fn try_recv(receiver: &mut PiRpcReceiver) -> pi_rpc::error::Result<Option<String>> {
        tokio::time::timeout(PATIENCE, receiver.recv())
            .await
            .expect("the channel answered in time")
    }

    #[tokio::test]
    async fn a_record_comes_back_once_without_its_line_feed() {
        let Wire {
            channel,
            mut stdout,
            ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();

        stdout
            .write_all(b"{\"a\":1}\n")
            .await
            .expect("the write lands");

        assert_eq!(recv(&mut receiver).await, Some("{\"a\":1}".to_string()));
    }

    #[tokio::test]
    async fn a_record_split_across_reads_comes_back_whole() {
        let Wire {
            channel,
            mut stdout,
            ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();

        stdout.write_all(b"{\"a\":").await.expect("the write lands");
        stdout.write_all(b"1}\n").await.expect("the write lands");

        assert_eq!(recv(&mut receiver).await, Some("{\"a\":1}".to_string()));
    }

    #[tokio::test]
    async fn several_records_of_one_read_come_back_in_order() {
        let Wire {
            channel,
            mut stdout,
            ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();

        stdout.write_all(b"a\nb\n").await.expect("the write lands");
        drop(stdout);

        assert_eq!(recv(&mut receiver).await, Some("a".to_string()));
        assert_eq!(recv(&mut receiver).await, Some("b".to_string()));
        assert_eq!(recv(&mut receiver).await, None);
    }

    #[tokio::test]
    async fn a_carriage_return_before_the_line_feed_is_stripped() {
        let Wire {
            channel,
            mut stdout,
            ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();

        stdout.write_all(b"x\r\n").await.expect("the write lands");

        assert_eq!(recv(&mut receiver).await, Some("x".to_string()));
    }

    #[tokio::test]
    async fn a_clean_end_is_no_record() {
        let Wire {
            channel, stdout, ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();
        drop(stdout);

        assert_eq!(recv(&mut receiver).await, None);
    }

    #[tokio::test]
    async fn a_partial_record_at_the_end_is_dropped() {
        let Wire {
            channel,
            mut stdout,
            ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();

        stdout.write_all(b"halves").await.expect("the write lands");
        drop(stdout);

        assert_eq!(recv(&mut receiver).await, None);
    }

    #[tokio::test]
    async fn a_record_that_is_not_utf8_is_a_protocol_failure() {
        let Wire {
            channel,
            mut stdout,
            ..
        } = Wire::new();
        let (_, mut receiver) = channel.split();

        stdout
            .write_all(&[0xff, 0xfe, b'\n'])
            .await
            .expect("the write lands");

        let error = try_recv(&mut receiver)
            .await
            .expect_err("the record is refused");
        assert_eq!(error.kind(), ErrorKind::Protocol);
    }

    #[tokio::test]
    async fn each_record_goes_out_with_exactly_one_line_feed() {
        let Wire {
            channel, mut stdin, ..
        } = Wire::new();
        let (mut sender, _) = channel.split();
        let mut written = [0u8; 2];

        sender
            .send("a".to_string())
            .await
            .expect("the record leaves");
        stdin
            .read_exact(&mut written)
            .await
            .expect("the program reads it");
        assert_eq!(&written, b"a\n");

        sender
            .send("bb".to_string())
            .await
            .expect("the record leaves");
        let mut written = [0u8; 3];
        stdin
            .read_exact(&mut written)
            .await
            .expect("the program reads it");
        assert_eq!(&written, b"bb\n");
    }

    #[tokio::test]
    async fn closing_ends_the_program_standard_input() {
        let Wire {
            channel, mut stdin, ..
        } = Wire::new();
        let (mut sender, _) = channel.split();

        sender.close().await.expect("the write side closes");

        let mut read = [0u8; 1];
        assert_eq!(stdin.read(&mut read).await.expect("the read lands"), 0);
    }

    #[tokio::test]
    async fn the_log_of_a_program_is_drained_to_its_end() {
        let (mut program, drain) = tokio::io::duplex(1024);
        let drain = tokio::spawn(drain_stderr(Box::new(drain)));

        program
            .write_all(b"one\ntwo\n")
            .await
            .expect("the write lands");
        // A line the decoder refuses resets it, and the drain goes on.
        program
            .write_all(&[0xff, b'\n'])
            .await
            .expect("the write lands");
        program
            .write_all(b"three\n")
            .await
            .expect("the write lands");
        drop(program);

        tokio::time::timeout(PATIENCE, drain)
            .await
            .expect("the drain ends")
            .expect("the drain task lives");
    }

    #[test]
    fn the_types_that_cross_a_task_are_send() {
        const fn assert_send<T: Send>() {}
        assert_send::<Channel>();
        assert_send::<PiRpcSender>();
        assert_send::<PiRpcReceiver>();
        assert_send::<Process>();
    }
}
