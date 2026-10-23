//! The machine pie talks to: reaching it, and what runs on it beside pi.
//!
//! Pi runs on the machine that has it - this machine, or a machine that pie
//! reaches over SSH - and everything pie does starts here. This module owns the
//! reach: the socket, the credentials, the host key, the version of the pi that
//! is installed there, the commands pie runs beside pi, and the files of the
//! machine. It owns no session: which pi processes exist, what they say, and what
//! happens when one ends belongs to [`session`](crate::session).
//!
//! Two machines, one vocabulary: [`Host`] answers for both, and the two
//! implementations live in `local` and `ssh`. A caller outside this module
//! never asks which machine it has.

pub(crate) mod files;
mod local;
mod ssh;
mod version;

pub use files::{DirEntry, Listing};
pub use local::LocalHost;
pub use ssh::{
    AskHostKey, ExecOutput, HostKey, KnownHosts, PresentedKey, RemoteCommand, SshAuth, SshHost, SshSession, SshTarget,
    SubsystemStream, Trust,
};
pub use version::{PI_VERSION, VersionMismatch, check_version, probe_version};

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::SystemTime;

use camino::Utf8Path;
use serde::Serialize;
use typed_path::Utf8TypedPath;

use crate::channel::Channel;

/// A boxed, sendable future returned by [`Host`] trait methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Progress callback `(transferred, total)` for file staging.
pub type ProgressFn<'a> = Box<dyn FnMut(u64, u64) + Send + 'a>;

/// The label of a machine: `local`, or `user@host:port`.
///
/// Used in UI headers, log lines, and error messages so the user can tell which
/// machine a message came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Endpoint(String);

impl Endpoint {
    /// Names an endpoint directly.
    pub fn new(label: impl Into<String>) -> Self {
        Self(label.into())
    }

    /// The endpoint of this machine.
    pub fn local() -> Self {
        Self::new("local")
    }

    /// Views the label as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Source data for staging an attachment on a [`Host`].
pub enum StageSource<'a> {
    /// A file that already exists on the local filesystem.
    ///
    /// [`LocalHost`] reuses this path without copying; [`SshHost`] reads and
    /// uploads the file over SFTP.
    LocalFile(&'a Utf8Path),
    /// In-memory file bytes.
    Bytes(&'a [u8]),
}

/// The raw lines and file metadata of one session file on a [`Host`].
#[derive(Debug, Default, Clone)]
pub struct SessionFileLines {
    /// Full path of the session file on the host.
    pub path: String,
    /// Last modification time of the file, if reported by the host.
    pub modified: Option<SystemTime>,
    /// First line of the file (the session header JSON).
    pub header: Option<String>,
    /// First user text extracted from the file.
    pub first: Option<String>,
    /// Latest display name extracted from the file (`None` when cleared or absent).
    pub name: Option<String>,
}

/// A machine pie reaches, and the pi that runs on it.
///
/// Callers hold `Arc<dyn Host>` and interact with the machine exclusively through
/// this trait without knowing whether it is local or remote.
pub trait Host: fmt::Debug + Send + Sync + 'static {
    /// Establishes or re-establishes the reach to the machine and verifies that
    /// `pi` can run on it.
    fn connect(&self) -> BoxFuture<'_, anyhow::Result<()>>;

    /// Whether the reach to the machine is still open.
    fn is_open(&self) -> bool;

    /// The label of this machine: `local`, or `user@host:port`.
    fn endpoint(&self) -> Endpoint;

    /// Starts `pi --mode rpc` on this machine, returning the channel and the
    /// starting working directory label (if known).
    fn open_pi<'a>(
        &'a self,
        cwd: Option<&'a str>,
        conversation: Option<&'a str>,
    ) -> BoxFuture<'a, anyhow::Result<(Channel, Option<String>)>>;

    /// Checks that the `pi` on this machine matches [`PI_VERSION`].
    fn check_pi(&self) -> BoxFuture<'_, anyhow::Result<()>>;

    /// Lists one directory level of this machine for the directory picker.
    fn dirs<'a>(&'a self, path: Option<&'a str>) -> BoxFuture<'a, anyhow::Result<Listing>>;

    /// Checks whether an absolute path names a directory on the machine.
    fn dir_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<bool>>;

    /// Creates a directory on the machine, with parents as needed.
    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<()>>;

    /// Removes a file on the machine.
    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<()>>;

    /// Scans the conversation files of `pi` on this machine and extracts the
    /// summary lines of each file.
    fn read_session_files(
        &self,
        first_text: fn(&[u8]) -> Option<String>,
        name_in: fn(&[u8]) -> Option<Option<String>>,
    ) -> BoxFuture<'_, anyhow::Result<Vec<SessionFileLines>>>;

    /// Stages a file where `pi` on this machine can read it, reporting progress
    /// through `on_progress`.
    fn stage_file<'a>(
        &'a self,
        name: &'a str,
        ext: &'a str,
        source: StageSource<'a>,
        on_progress: ProgressFn<'a>,
    ) -> BoxFuture<'a, anyhow::Result<String>>;

    /// Ends the reach to the machine.
    fn close(&self) -> BoxFuture<'_, ()>;
}

/// Logs a [`VersionMismatch`] as a warning and lets the connection proceed.
pub(super) fn accept_version_mismatch(result: anyhow::Result<()>) -> anyhow::Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.downcast_ref::<VersionMismatch>().is_some() => {
            tracing::warn!(%error, "the pi of this machine is not the release pie speaks; going on");
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// Validates that a host path is absolute (POSIX or Windows) before any channel
/// or process is touched.
pub(crate) fn checked_host_path(path: &str) -> anyhow::Result<&str> {
    if Utf8TypedPath::derive(path).is_absolute() {
        Ok(path)
    } else {
        Err(files::not_absolute(path))
    }
}

/// What the frontend hears about a connection during the handshake.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionState {
    /// A host presented a key that is in no store. Therefore the connection
    /// waits for a person. The result of an answer that never arrives is the
    /// business of the frontend: the frontend decides the length of the wait,
    /// and no answer is a refusal.
    HostKey {
        /// The key in the values that a person compares.
        key: PresentedKey,
    },

    /// The reach to the machine ended. Pie holds the connection, and nothing on
    /// it answers any more: a network that went away, a host that slept. The
    /// frontend decides what happens next - a person may bring the reach back, or
    /// leave for the connect screen.
    Ended,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_machine_is_always_open() {
        let host: Box<dyn Host> = Box::new(LocalHost::new(None));
        assert!(host.is_open());
        assert_eq!(host.endpoint().as_str(), "local");
    }

    #[test]
    fn the_end_of_a_reach_travels_under_a_tag_of_its_own() {
        assert_eq!(
            serde_json::to_value(ConnectionState::Ended).expect("an end serializes"),
            serde_json::json!({ "type": "ended" })
        );
    }

    #[test]
    fn checked_host_path_accepts_posix_and_windows_roots_and_rejects_relative_paths() {
        for path in [
            "/",
            "/home/u/.pi/agent/sessions/one.jsonl",
            "C:\\Users\\u\\.pi\\agent\\sessions\\one.jsonl",
            "c:/Users/u/.pi/agent/sessions/one.jsonl",
            "\\\\server\\share\\sessions\\one.jsonl",
        ] {
            assert_eq!(
                checked_host_path(path).expect("absolute path"),
                path,
                "`{path}` is absolute"
            );
        }

        for path in [
            "",
            ".",
            "..",
            "sessions/one.jsonl",
            "./one.jsonl",
            "../one.jsonl",
            "C:relative\\one.jsonl",
            "\\Users\\u\\one.jsonl",
        ] {
            assert!(
                checked_host_path(path).is_err(),
                "`{path}` is relative and must not pass as absolute"
            );
        }
    }
}
