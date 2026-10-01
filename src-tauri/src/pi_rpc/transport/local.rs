//! pi as a local child process.
//!
//! ```no_run
//! use pie_lib::pi_rpc::transport::LocalTransport;
//!
//! # fn example() -> pie_lib::pi_rpc::Result<()> {
//! let process = LocalTransport::pi().arg("--no-session").spawn()?;
//! # let _ = process;
//! # Ok(())
//! # }
//! ```

use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};

use tokio::io::AsyncRead;
use tokio::process::{Child, ChildStdin, ChildStdout};

use super::{Control, Termination, Transport, TransportParts};
use crate::pi_rpc::error::{Error, Result};

/// Builds the command that starts pi.
///
/// `pi` must be on `PATH` of the machine that runs it - pie never bundles it.
/// Which session flags to pass (`--no-session`, `--session-dir`, ...) is the
/// caller's decision.
#[derive(Debug)]
pub struct LocalTransport {
    command: std::process::Command,
}

impl LocalTransport {
    /// Prepares to run `program`.
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            command: std::process::Command::new(program.into()),
        }
    }

    /// Prepares pi in RPC mode: `pi --mode rpc`.
    pub fn pi() -> Self {
        Self::new("pi").args(["--mode", "rpc"])
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

    /// Sets the working directory pi starts in.
    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.command.current_dir(dir.into());
        self
    }

    /// Sets an environment variable.
    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.command.env(key, value);
        self
    }

    /// Removes an environment variable for the child.
    pub fn env_remove(mut self, key: impl AsRef<OsStr>) -> Self {
        self.command.env_remove(key);
        self
    }

    /// Starts the process with piped stdio.
    ///
    /// The child is killed when the client is dropped without a graceful
    /// shutdown, so an orphaned pi cannot outlive the app.
    ///
    /// # Errors
    ///
    /// [`Error::Spawn`] when the binary is missing, not executable, or the
    /// process cannot be created.
    pub fn spawn(self) -> Result<LocalProcess> {
        let mut command = tokio::process::Command::from(self.command);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let program = command.as_std().get_program().to_string_lossy().into_owned();
        let child = command.spawn().map_err(|source| Error::Spawn {
            program: program.clone(),
            source,
        })?;
        Ok(LocalProcess { child, program })
    }
}

/// A running pi child process.
///
/// Implement with [`Client::start`](crate::pi_rpc::Client::start).
#[derive(Debug)]
pub struct LocalProcess {
    child: Child,
    program: String,
}

impl LocalProcess {
    /// Process id, or `None` once the child has been reaped.
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Program that was started, for diagnostics.
    pub fn program(&self) -> &str {
        &self.program
    }
}

impl Transport for LocalProcess {
    type Reader = ChildStdout;
    type Writer = ChildStdin;
    type Control = LocalControl;

    fn split(mut self) -> Result<TransportParts<Self::Reader, Self::Writer, Self::Control>> {
        let reader = self.child.stdout.take().ok_or_else(|| missing_pipe("stdout"))?;
        let writer = self.child.stdin.take().ok_or_else(|| missing_pipe("stdin"))?;
        let diagnostics = self.child.stderr.take();
        Ok(TransportParts {
            reader,
            writer,
            control: LocalControl {
                child: self.child,
                program: self.program,
            },
            diagnostics: diagnostics.map(|stderr| Box::new(stderr) as Box<dyn AsyncRead + Unpin + Send>),
        })
    }
}

/// Lifecycle of a [`LocalProcess`].
#[derive(Debug)]
pub struct LocalControl {
    child: Child,
    program: String,
}

impl LocalControl {
    /// Program behind this handle, for diagnostics.
    pub fn program(&self) -> &str {
        &self.program
    }
}

impl Control for LocalControl {
    async fn terminate(&mut self) -> Result<()> {
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

    async fn wait(&mut self) -> Result<Termination> {
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

/// Error for a pipe the process did not hand over.
fn missing_pipe(name: &str) -> Error {
    Error::Io(std::io::Error::other(format!("pi's {name} pipe is not available")))
}
