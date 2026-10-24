//! Starting programs on a machine, and capturing one-shot output.

use std::{fmt, time::Duration};

use crate::channel::{Channel, Termination};

/// How long a one-shot command has to finish.
///
/// The commands pie captures whole are small checks - a version probe, a
/// directory listing - where half a minute is generous. The bound is the promise
/// that the call returns whatever the command does.
pub(crate) const OUTPUT_TIMEOUT: Duration = Duration::from_secs(30);

/// How to start one program on a machine.
#[derive(Debug, Clone)]
pub struct CommandSpec {
    /// The program to run.
    pub program: String,
    /// Its arguments, in order.
    pub args: Vec<String>,
    /// The directory it starts in, as the machine writes it.
    pub current_dir: Option<String>,
}

impl CommandSpec {
    /// Prepares to run `program`.
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
        }
    }

    /// Appends one argument.
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Appends arguments.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Sets the directory the program starts in.
    pub fn current_dir(mut self, dir: impl Into<String>) -> Self {
        self.current_dir = Some(dir.into());
        self
    }
}

/// What a command printed and how it ended.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    /// The command's standard output.
    pub stdout: Vec<u8>,
    /// The command's standard error.
    pub stderr: Vec<u8>,
    /// How the command ended.
    pub termination: Termination,
}

/// Starting programs on one machine.
#[async_trait::async_trait]
pub trait Exec: fmt::Debug + Send + Sync + 'static {
    /// Starts `command` and returns the channel that carries its life and bytes.
    async fn spawn(&self, command: CommandSpec) -> anyhow::Result<Channel>;

    /// Runs `command` to completion and captures what it printed.
    async fn output(&self, command: CommandSpec) -> anyhow::Result<ExecOutput>;
}
