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

pub use files::{DirEntry, FileEntry, Listing, SeekableReader};
pub use local::LocalHost;
pub use ssh::{
    AskHostKey, ExecOutput, HostKey, KnownHosts, PresentedKey, RemoteCommand, SshAuth, SshHost, SshSession, SshTarget,
    SubsystemStream, Trust,
};

use crate::channel::Channel;
use camino::Utf8Path;
use serde::Serialize;
use std::fmt;
use typed_path::Utf8TypedPath;

/// The Pi release this crate mirrors.
pub const PI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// What a packaged pi reports when its build had no version to bake in: "cannot tell".
pub const UNKNOWN_VERSION: &str = "0.0.0";

/// Compares a reported version against [`PI_VERSION`].
pub fn check_version(found: &str) -> Result<(), VersionMismatch> {
    let found = found.trim();
    if found == PI_VERSION || found == UNKNOWN_VERSION {
        Ok(())
    } else {
        Err(VersionMismatch {
            expected: PI_VERSION.to_string(),
            found: found.to_string(),
        })
    }
}

/// The `pi` on a machine is not the release that pie mirrors.
#[derive(Debug, thiserror::Error)]
#[error("pi version mismatch: expected {expected}, found {found}")]
pub struct VersionMismatch {
    /// Version pie mirrors.
    pub expected: String,
    /// Version reported by the probed binary.
    pub found: String,
}

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

/// Progress callback `(transferred, total)` for file staging.
pub type ProgressFn<'a> = Box<dyn FnMut(u64, u64) + Send + 'a>;

/// A machine pie reaches, and the pi that runs on it.
///
/// Callers hold `Arc<dyn Host>` and interact with the machine exclusively through
/// this trait without knowing whether it is local or remote.
#[async_trait::async_trait]
pub trait Host: fmt::Debug + Send + Sync + 'static {
    /// Establishes or re-establishes the reach to the machine and verifies that
    /// `pi` can run on it.
    async fn connect(&self) -> anyhow::Result<()>;

    /// Whether the reach to the machine is still open.
    fn is_open(&self) -> bool;

    /// The label of this machine: `local`, or `user@host:port`.
    fn endpoint(&self) -> Endpoint;

    /// Starts `pi --mode rpc` on this machine in `cwd`, returning the channel and the
    /// starting working directory label (if known).
    async fn open_pi(&self, cwd: &str, conversation: Option<&str>) -> anyhow::Result<(Channel, Option<String>)>;

    /// Returns the version string reported by `pi --version` on this machine.
    async fn pi_version(&self) -> anyhow::Result<String>;

    /// Lists one directory level of this machine for the directory picker.
    async fn dirs(&self, path: &str) -> anyhow::Result<Listing>;

    /// Checks whether an absolute path names a directory on the machine.
    async fn dir_exists(&self, path: &str) -> anyhow::Result<bool>;

    /// Creates a directory on the machine, with parents as needed.
    async fn create_dir(&self, path: &str) -> anyhow::Result<()>;

    /// Returns the login home directory of this machine, if known.
    async fn home_dir(&self) -> anyhow::Result<Option<String>>;

    /// Reads directory entries of a directory on the machine.
    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<FileEntry>>;

    /// Opens a file for seekable asynchronous reading.
    async fn open_file(&self, path: &str) -> anyhow::Result<Box<dyn SeekableReader>>;

    /// Removes a file on the machine.
    async fn remove_file(&self, path: &str) -> anyhow::Result<()>;

    /// Reads metadata for a path on the machine.
    async fn metadata(&self, path: &str) -> anyhow::Result<FileEntry>;

    /// Stages a file where `pi` on this machine can read it, reporting progress
    /// through `on_progress`.
    async fn stage_file(
        &self,
        name: &str,
        ext: &str,
        source: StageSource<'_>,
        on_progress: ProgressFn<'_>,
    ) -> anyhow::Result<String>;

    /// Ends the reach to the machine.
    async fn close(&self);
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

pub(crate) use checked_host_path as is_absolute_path;

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
    fn check_version_accepts_the_pin_and_unknown() {
        assert!(check_version(PI_VERSION).is_ok());
        assert!(check_version(format!(" {PI_VERSION}\n").as_str()).is_ok());
        assert!(check_version(UNKNOWN_VERSION).is_ok());

        let mismatch = check_version("0.0.1").unwrap_err();
        assert_eq!(mismatch.expected, PI_VERSION);
        assert_eq!(mismatch.found, "0.0.1");
    }

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
                is_absolute_path(path).expect("absolute path"),
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
                is_absolute_path(path).is_err(),
                "`{path}` is relative and must not pass as absolute"
            );
        }
    }
}
