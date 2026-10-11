//! A program as a child process of this machine.
//!
//! The channel over such a process is its pipes: standard output for the
//! records, standard input for the answers, standard error for the log. Every
//! pipe is taken at [`Program::spawn`], where a missing one can still be
//! reported: after that a channel is only bytes and a life.
//!
//! ```no_run
//! use pie_lib::channel::Program;
//!
//! # fn example() -> pie_lib::channel::Result<()> {
//! let channel = Program::new("pi").args(["--mode", "rpc"]).spawn()?;
//! let handle = channel.handle();
//! # let _ = handle;
//! # Ok(())
//! # }
//! ```

use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};

use tokio::process::Child;

use super::{Channel, Error, Result, Termination};

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

    /// Sets the working directory the program starts in.
    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
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
    /// [`Error::Spawn`] when the binary is missing, not executable, or the
    /// process cannot be created, and [`Error::Io`] when a pipe that the start
    /// asked for is not there.
    ///
    /// # Panics
    ///
    /// Without a Tokio runtime, like the channel's own assembly.
    pub fn spawn(self) -> Result<Channel> {
        let mut command = tokio::process::Command::from(self.command);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let program = command.as_std().get_program().to_string_lossy().into_owned();
        let mut child = command.spawn().map_err(|source| Error::Spawn {
            program: program.clone(),
            source,
        })?;

        let stdout = child.stdout.take().ok_or_else(|| Error::missing_pipe("stdout"))?;
        let stdin = child.stdin.take().ok_or_else(|| Error::missing_pipe("stdin"))?;
        let stderr = child.stderr.take().ok_or_else(|| Error::missing_pipe("stderr"))?;

        Ok(Channel::of(
            Box::new(stdout),
            Box::new(stdin),
            Box::new(stderr),
            super::Behind::Stdio(Control { child }),
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
    pub(crate) async fn terminate(&mut self) -> Result<()> {
        if self.child.id().is_none() {
            return Ok(());
        }
        match self.child.kill().await {
            Ok(()) => Ok(()),
            // Already gone: the exit status is collected by `wait`.
            Err(error) if error.kind() == ErrorKind::InvalidInput => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Waits for the process to end and reports how it ended.
    pub(crate) async fn wait(&mut self) -> Result<Termination> {
        let status = self.child.wait().await?;
        Ok(termination_of(status))
    }
}

/// Maps a process exit status onto [`Termination`].
fn termination_of(status: ExitStatus) -> Termination {
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
