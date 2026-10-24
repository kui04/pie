//! A program as a child process of this machine.
//!
//! The channel over such a process is its pipes: standard output for the
//! records, standard input for the answers, standard error for the log. Every
//! pipe is taken at [`Program::spawn`], where a missing one can still be
//! reported: after that a channel is only bytes and a life.

use std::{
    ffi::{OsStr, OsString},
    io::ErrorKind,
    path::PathBuf,
    process::{ExitStatus, Stdio},
};

use anyhow::Context as _;
use tokio::process::Child;

use super::{Channel, Termination};

/// How to start a program on this machine.
///
/// The setters are free of failure; [`Program::spawn`] is where a program that
/// cannot start is reported. The program must be on `PATH` of this machine: pie
/// never bundles one.
#[derive(Debug)]
pub struct Program {
    command: std::process::Command,
}

impl Program {
    /// Prepares to run `program`.
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            command: std::process::Command::new(program.into()),
        }
    }

    /// Appends one argument.
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.command.arg(arg.into());
        self
    }

    /// Appends arguments.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.command.args(args);
        self
    }

    /// Sets the current directory the program starts in.
    pub fn current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.command.current_dir(dir.into());
        self
    }

    /// Starts the program with piped stdio and takes its pipes.
    ///
    /// The child is killed when the last hand on it goes, so an orphan cannot
    /// outlive the app.
    ///
    /// # Errors
    ///
    /// A failure with the program's name when the binary is missing, not
    /// executable, or the process cannot be created, and one when a pipe that
    /// the start asked for is not there.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime, like the channel's own assembly.
    pub fn spawn(self) -> anyhow::Result<Channel> {
        let mut command = tokio::process::Command::from(self.command);
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

        Ok(Channel::new(
            stdout,
            stdin,
            stderr,
            super::Lifecycle::Stdio(Control { child }),
        ))
    }
}

/// The running process behind a [`Program`](super::stdio::Program).
#[derive(Debug)]
pub(crate) struct Control {
    child: Child,
}

impl Control {
    /// Ends the process now, and reaps it.
    pub(super) async fn terminate(&mut self) {
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

    /// Waits for the process to end and reports how it ended.
    pub(super) async fn wait(&mut self) -> Termination {
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
