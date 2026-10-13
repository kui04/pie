//! Pi on this machine.
//!
//! The reach to this machine needs nothing: there is no socket to open, no
//! credential to present, and no host key to trust. What is left is where pi
//! starts, and where its sessions are read - which belongs to the session store,
//! because it is the layout of pi and not of the machine.

use std::path::{Path, PathBuf};

use crate::channel::{Channel, Program};

use super::version::{check_version, probe_version};
use super::{HostPath, Result};

/// The arguments of the `pi` of this machine: the RPC mode, and the conversation
/// to load at the start when one is named.
///
/// Pi reads the conversation path itself, on the machine where it runs, so the
/// path travels as the host wrote it.
fn pi_args(conversation: Option<&HostPath>) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    if let Some(path) = conversation {
        args.push("--session".to_string());
        args.push(path.as_str().to_string());
    }
    args
}

/// This machine, as a machine that runs pi.
pub struct LocalHost {
    /// The home directory of this machine: the start of a session when the
    /// frontend names no directory. `None` leaves pi in the directory of the
    /// app, which is the result on a platform without a home directory.
    home: Option<PathBuf>,
}

impl std::fmt::Debug for LocalHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("LocalHost").field("home", &self.home).finish()
    }
}

impl LocalHost {
    /// The machine the app itself runs on, with the home the app resolved.
    pub(crate) fn new(home: Option<PathBuf>) -> Self {
        Self { home }
    }

    /// The home directory of this machine.
    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// Starts `pi --mode rpc` in a session of this machine.
    ///
    /// `cwd` is the directory the session was asked for; without one pi starts
    /// in the home directory of this machine, or in the directory of the app
    /// when there is no home either.
    ///
    /// `conversation` is a conversation file of pi to load at the start
    /// (`--session`). `None` starts a new conversation; pi creates the file at
    /// the first message.
    ///
    /// # Errors
    ///
    /// The channel's own failures: a `pi` that is not on `PATH` is
    /// [`channel::Error::Spawn`](crate::channel::Error::Spawn).
    pub(crate) fn open_pi(
        &self,
        cwd: Option<&HostPath>,
        conversation: Option<&HostPath>,
    ) -> crate::channel::Result<Channel> {
        let dir = cwd
            .map(|path| PathBuf::from(path.as_str()))
            .or_else(|| self.home.clone());
        let program = match dir {
            Some(dir) => Program::new("pi").args(pi_args(conversation)).cwd(dir),
            None => Program::new("pi").args(pi_args(conversation)),
        };
        program.spawn()
    }

    /// Checks that the `pi` on this machine is the release pie speaks.
    ///
    /// A pi that is not the release of this build speaks a protocol that pie
    /// does not know. Without the check, the mismatch looks like a fault of pi,
    /// not like the wrong pi.
    ///
    /// # Errors
    ///
    /// [`Error::VersionProbe`] when `pi --version` cannot be read, and
    /// [`Error::VersionMismatch`] when it reports another release.
    pub(crate) async fn check_pi(&self) -> Result<()> {
        let found = probe_version("pi").await?;
        check_version(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conversation_is_passed_as_a_session_argument() {
        assert_eq!(pi_args(None), ["--mode", "rpc"]);

        let path = HostPath::new("/tmp/sessions/one.jsonl");
        assert_eq!(
            pi_args(Some(&path)),
            ["--mode", "rpc", "--session", "/tmp/sessions/one.jsonl"]
        );
    }
}
