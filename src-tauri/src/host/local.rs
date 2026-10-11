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
    /// # Errors
    ///
    /// The channel's own failures: a `pi` that is not on `PATH` is
    /// [`channel::Error::Spawn`](crate::channel::Error::Spawn).
    pub(crate) fn open_pi(&self, cwd: Option<&HostPath>) -> crate::channel::Result<Channel> {
        let dir = cwd
            .map(|path| PathBuf::from(path.as_str()))
            .or_else(|| self.home.clone());
        let program = match dir {
            Some(dir) => Program::new("pi").args(["--mode", "rpc"]).cwd(dir),
            None => Program::new("pi").args(["--mode", "rpc"]),
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
