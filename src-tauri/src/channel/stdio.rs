//! A program as a child process of this machine.
//!
//! The channel over such a process is its pipes: standard output for the
//! records, standard input for the answers, standard error for the log.

use std::{
    io::ErrorKind,
    process::{ExitStatus, Stdio},
};

use anyhow::Context as _;
use tokio::process::Child;

use super::{Channel, Lifecycle, Termination};

/// Starts the program with piped stdio and takes its pipes.
///
/// The child is killed when the last hand on it goes, so an orphan cannot
/// outlive the app.
pub(super) fn spawn(mut command: tokio::process::Command) -> anyhow::Result<Channel> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let program = command.as_std().get_program().to_string_lossy().into_owned();
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start `{program}`"))?;

    let stdout = child
        .stdout
        .take()
        .context("the program's stdout pipe is not available")?;
    let stdin = child
        .stdin
        .take()
        .context("the program's stdin pipe is not available")?;
    let stderr = child
        .stderr
        .take()
        .context("the program's stderr pipe is not available")?;

    Ok(Channel::new(stdout, stdin, stderr, Box::new(Process { child })))
}

/// The running process behind a child channel.
#[derive(Debug)]
struct Process {
    child: Child,
}

#[async_trait::async_trait]
impl Lifecycle for Process {
    async fn terminate(&mut self) {
        if self.child.id().is_none() {
            return;
        }
        if let Err(error) = self.child.kill().await {
            // Already gone: the exit status is collected by `wait`.
            if error.kind() != ErrorKind::InvalidInput {
                tracing::debug!(%error, "asking the process to stop failed");
            }
        }
    }

    async fn wait(&mut self) -> Termination {
        match self.child.wait().await {
            Ok(status) => Termination::from(status),
            Err(error) => {
                tracing::debug!(%error, "waiting for the process failed");
                Termination::Unknown
            }
        }
    }
}

impl From<ExitStatus> for Termination {
    fn from(status: ExitStatus) -> Self {
        if let Some(code) = status.code() {
            return Termination::Exited {
                code,
                success: status.success(),
            };
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                return Termination::Signalled { signal };
            }
        }
        Termination::Unknown
    }
}
