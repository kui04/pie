//! A command as the shell of the machine runs it.
//!
//! [`RemoteCommand`] is the one place that decides how a command reaches a remote
//! shell: one line, with the working directory that pie wants it to start in,
//! quoted so a directory that a person picked cannot become syntax. [`quote`] is
//! that rule, and it is shared: the session store builds its own commands with it.

/// A command to run in an exec channel, and where to start it.
#[derive(Debug, Clone)]
pub struct RemoteCommand {
    command: String,
    dir: Option<String>,
}

impl RemoteCommand {
    /// Runs `command` in the login shell's own directory.
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            dir: None,
        }
    }

    /// Starts the command in `dir`, for the shell that runs it remotely.
    ///
    /// The directory is quoted: it reaches us as user input from a directory
    /// picker and must not become shell syntax.
    pub fn cwd(mut self, dir: impl AsRef<str>) -> Self {
        self.dir = Some(dir.as_ref().to_string());
        self
    }

    /// The command as the remote shell will run it, `cd` prefix included.
    ///
    /// Composed here, at the point of use, rather than built up piece by piece:
    /// the remote working directory is how a session picks its project, and a
    /// composition that could be overwritten after the fact would make losing it
    /// a silent mistake.
    pub fn command_line(&self) -> String {
        match &self.dir {
            Some(dir) => format!("cd -- {} && {}", quote(dir), self.command),
            None => self.command.clone(),
        }
    }
}

impl From<&str> for RemoteCommand {
    fn from(command: &str) -> Self {
        Self::new(command)
    }
}

impl From<String> for RemoteCommand {
    fn from(command: String) -> Self {
        Self::new(command)
    }
}

/// Quotes `text` for a POSIX shell, so it reaches the command unmangled.
///
/// A path that a person selected and a path that pi wrote both go through here:
/// the machine's shell is what decides where a value ends, and two spellings of
/// that rule would be one too many.
pub(super) fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_directory_prefixes_a_quoted_command() {
        assert_eq!(
            RemoteCommand::new("pi --mode rpc").cwd("/srv/work").command_line(),
            "cd -- '/srv/work' && pi --mode rpc"
        );
    }

    #[test]
    fn quoting_survives_quotes_and_spaces() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("with space"), "'with space'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(
            RemoteCommand::new("pi --mode rpc")
                .cwd("/home/o'brien/pie")
                .command_line(),
            r"cd -- '/home/o'\''brien/pie' && pi --mode rpc"
        );
    }

    #[test]
    fn a_command_without_a_working_directory_runs_as_given() {
        assert_eq!(RemoteCommand::new("sh -c 'echo hi'").command_line(), "sh -c 'echo hi'");
    }

    #[test]
    fn a_working_directory_applies_to_whatever_the_command_is() {
        assert_eq!(
            RemoteCommand::new("sh -c 'ls'").cwd("/srv/work").command_line(),
            "cd -- '/srv/work' && sh -c 'ls'"
        );
    }
}
