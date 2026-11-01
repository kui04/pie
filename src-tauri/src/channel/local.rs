use std::io::ErrorKind;
use std::process::Stdio;

use anyhow::Context as _;

use crate::channel::{Channel, ExitStatus, Handle};

/// A child process of this machine.
pub struct LocalProcess {
    child: tokio::process::Child,
}

/// Starts a program on this machine: its pipes become a [`Channel`], its life
/// becomes a [`LocalProcess`].
///
/// The child is killed when the last hand on it goes, so a program cannot
/// outlive the app.
pub(crate) fn spawn(
    mut command: tokio::process::Command,
) -> anyhow::Result<(Channel, LocalProcess)> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let program = command
        .as_std()
        .get_program()
        .to_string_lossy()
        .into_owned();
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start `{program}`"))?;

    let stdin = child
        .stdin
        .take()
        .context("the program's stdin pipe is not available")?;
    let stdout = child
        .stdout
        .take()
        .context("the program's stdout pipe is not available")?;
    let stderr = child
        .stderr
        .take()
        .context("the program's stderr pipe is not available")?;

    let channel = Channel::new(Box::new(stdin), Box::new(stdout), Box::new(stderr));
    Ok((channel, LocalProcess { child }))
}

impl std::fmt::Debug for LocalProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LocalProcessHandler(<child>)")
    }
}

impl Handle for LocalProcess {
    async fn wait(&mut self) -> anyhow::Result<ExitStatus> {
        let status = self
            .child
            .wait()
            .await
            .context("failed to wait for the process")?;
        Ok(status.into())
    }

    fn try_wait(&mut self) -> anyhow::Result<Option<ExitStatus>> {
        let status = self
            .child
            .try_wait()
            .context("failed to check whether the process ended")?;
        Ok(status.map(ExitStatus::from))
    }

    async fn kill(&mut self) -> anyhow::Result<()> {
        match self.child.kill().await {
            // A process that already ended has nothing left to kill.
            Err(error) if error.kind() == ErrorKind::InvalidInput => Ok(()),
            result => result.context("failed to kill the process"),
        }
    }
}

impl From<std::process::ExitStatus> for ExitStatus {
    fn from(status: std::process::ExitStatus) -> Self {
        if let Some(code) = status.code() {
            return Self::exited(code);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                return Self::signalled(signal);
            }
        }
        // Neither an exit code nor a signal: the platform told pie nothing.
        Self::unknown()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use pi_rpc::transport::{Transport, TransportRecv};

    use super::*;

    /// The next record of a channel, or `None` at a clean end.
    async fn recv(receiver: &mut crate::channel::PiRpcReceiver) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("the channel answered in time")
            .expect("the channel took the record")
    }

    /// A process of this machine, started by the shell the tests already run in.
    fn process(script: &str) -> LocalProcess {
        LocalProcess {
            child: tokio::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .spawn()
                .expect("a shell starts"),
        }
    }

    #[tokio::test]
    async fn a_successful_exit_is_a_success() {
        let mut process = process("exit 0");

        let status = process.wait().await.expect("the process ends");

        assert_eq!(status.code(), Some(0));
        assert_eq!(status.signal(), None);
        assert!(status.is_success());
        assert!(!status.is_signalled());
    }

    #[tokio::test]
    async fn a_failing_exit_keeps_its_code() {
        let mut process = process("exit 3");

        let status = process.wait().await.expect("the process ends");

        assert_eq!(status.code(), Some(3));
        assert_eq!(status.signal(), None);
        assert!(!status.is_success());
    }

    #[tokio::test]
    async fn a_process_that_runs_is_not_yet_ended() {
        let mut process = process("sleep 10");

        assert_eq!(process.try_wait().expect("the check lands"), None);
    }

    #[tokio::test]
    async fn a_killed_process_is_reported_by_its_signal() {
        let mut process = process("sleep 10");

        process.kill().await.expect("the kill lands");
        let status = process.wait().await.expect("the process ends");

        assert_eq!(status.code(), None);
        assert_eq!(status.signal(), Some(9));
        assert!(status.is_signalled());
        assert!(!status.is_success());
    }

    #[tokio::test]
    async fn an_ended_process_reports_the_same_status_either_way() {
        let mut process = process("exit 4");

        let waited = process.wait().await.expect("the process ends");
        let checked = process.try_wait().expect("the check lands");

        assert_eq!(checked, Some(waited));
    }

    #[tokio::test]
    async fn killing_an_ended_process_is_not_a_failure() {
        let mut process = process("exit 0");
        process.wait().await.expect("the process ends");

        process
            .kill()
            .await
            .expect("a dead process has nothing left to kill");
    }

    #[tokio::test]
    async fn a_started_program_speaks_through_the_channel() {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg("printf 'one\\ntwo\\n'");

        let (channel, mut process) = spawn(command).expect("the program starts");
        let (_, mut receiver) = channel.split();

        assert_eq!(recv(&mut receiver).await, Some("one".to_string()));
        assert_eq!(recv(&mut receiver).await, Some("two".to_string()));
        assert_eq!(recv(&mut receiver).await, None);

        let status = process.wait().await.expect("the program ends");
        assert!(status.is_success());
    }
}
