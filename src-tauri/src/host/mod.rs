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

mod connection;
mod exec;
pub(crate) mod files;
mod local;
mod path;
mod ssh;

use std::{fmt, sync::Arc};

use camino::Utf8PathBuf;
pub use connection::Connection;
pub use exec::{CommandSpec, Exec, ExecOutput};
pub use files::{AsyncReadSeek, DirEntry, FileEntry, Files, Listing, ProgressFn, StageSource};
pub use local::LocalHost;
use serde::Serialize;
pub use ssh::{
    AskHostKey, HostKey, KnownHosts, PresentedKey, SshAuth, SshHost, SshSession, SshTarget, SubsystemStream, Trust,
};

use crate::channel::Channel;

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

/// A machine pie reaches, and the pi that runs on it.
///
/// A host composes the three capabilities of one machine: its reach
/// ([`Connection`]), its files ([`Files`]), and its programs ([`Exec`]).
/// Callers hold `Arc<Host>` and never ask which machine they have.
#[derive(Debug, Clone)]
pub struct Host {
    connection: Arc<dyn Connection>,
    files: Arc<dyn Files>,
    exec: Arc<dyn Exec>,
    path_style: path::PathStyle,
}

impl Host {
    /// Assembles a host from its three capabilities.
    ///
    /// The three must belong to the same machine: `connect` opens the reach and
    /// then probes `pi` through `exec`.
    pub(crate) fn new(
        connection: Arc<dyn Connection>,
        files: Arc<dyn Files>,
        exec: Arc<dyn Exec>,
        path_style: path::PathStyle,
    ) -> Self {
        Self {
            connection,
            files,
            exec,
            path_style,
        }
    }

    /// The machine the app itself runs on, with the home the app resolved.
    pub fn local(home: Option<Utf8PathBuf>) -> Self {
        let local = Arc::new(LocalHost::new(home));
        let connection: Arc<dyn Connection> = local.clone();
        let files: Arc<dyn Files> = local.clone();
        let exec: Arc<dyn Exec> = local;
        Self::new(connection, files, exec, path::PathStyle::Native)
    }

    /// A machine reached over SSH.
    pub fn ssh(target: SshTarget, auth: SshAuth, trust: Trust) -> Self {
        let remote = Arc::new(SshHost::new(target, auth, trust));
        let connection: Arc<dyn Connection> = remote.clone();
        let files: Arc<dyn Files> = remote.clone();
        let exec: Arc<dyn Exec> = remote;
        Self::new(connection, files, exec, path::PathStyle::Posix)
    }

    /// Establishes or re-establishes the reach and verifies that `pi` runs on it.
    pub async fn connect(&self) -> anyhow::Result<()> {
        self.connection.connect().await?;
        match self.pi_version().await {
            Ok(version) => {
                if let Err(mismatch) = check_version(&version) {
                    tracing::warn!(%mismatch, "the pi of this machine is not the release pie speaks; going on");
                }
                Ok(())
            }
            Err(error) => {
                self.connection.close().await;
                Err(error)
            }
        }
    }

    /// Whether the reach to the machine is still open.
    pub fn is_open(&self) -> bool {
        self.connection.is_open()
    }

    /// The label of this machine: `local`, or `user@host:port`.
    pub fn endpoint(&self) -> Endpoint {
        self.connection.endpoint()
    }

    /// Ends the reach to the machine.
    pub async fn close(&self) {
        self.connection.close().await;
    }

    /// The file operations of this machine.
    pub fn files(&self) -> &dyn Files {
        self.files.as_ref()
    }

    /// Another hand on the file operations, for a task that must own them.
    pub fn files_arc(&self) -> Arc<dyn Files> {
        Arc::clone(&self.files)
    }

    /// The program operations of this machine.
    pub fn exec(&self) -> &dyn Exec {
        self.exec.as_ref()
    }

    /// Starts `pi --mode rpc` on this machine in `current_dir`, returning the
    /// channel and the starting working directory label.
    pub async fn spawn_pi(
        &self,
        current_dir: &str,
        session_file: Option<&str>,
    ) -> anyhow::Result<(Channel, Option<String>)> {
        let current_dir = path::checked(current_dir, self.path_style)?;
        let session_file = session_file
            .map(|path| path::checked(path, self.path_style))
            .transpose()?;
        let mut command = CommandSpec::new("pi").args(["--mode", "rpc"]).current_dir(current_dir);
        if let Some(session_file) = session_file {
            command = command.args(["--session", session_file]);
        }
        let channel = self.exec.spawn(command).await?;
        Ok((channel, Some(current_dir.to_string())))
    }

    /// Returns the version string reported by `pi --version` on this machine.
    pub async fn pi_version(&self) -> anyhow::Result<String> {
        let output = self.exec.output(CommandSpec::new("pi").arg("--version")).await?;
        version_of(&output, &self.endpoint())
    }

    /// Lists one directory level of this machine for the directory picker.
    pub async fn list_dirs(&self, path: &str) -> anyhow::Result<Listing> {
        let mut entries: Vec<DirEntry> = self
            .files
            .read_dir(path)
            .await?
            .into_iter()
            .map(|entry| DirEntry {
                name: entry.name,
                path: entry.path,
                is_dir: entry.is_dir,
            })
            .collect();
        files::sort_dirs_first(&mut entries);
        Ok(Listing {
            directory: path.to_string(),
            entries,
        })
    }
}

/// Reads the version that a `pi --version` capture reported.
pub(crate) fn version_of(output: &ExecOutput, endpoint: &Endpoint) -> anyhow::Result<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let crate::channel::Termination::Exited { success: true, .. } = output.termination
        && !stdout.is_empty()
    {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let said = stderr.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    if said.is_empty() {
        anyhow::bail!("`pi --version` on {endpoint} failed with {:?}", output.termination);
    }
    anyhow::bail!("`pi --version` on {endpoint} failed: {said}");
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
        let host = Host::local(None);
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
    fn the_native_path_style_accepts_posix_and_windows_roots_and_rejects_relative_paths() {
        for path in [
            "/",
            "/home/u/.pi/agent/sessions/one.jsonl",
            "C:\\Users\\u\\.pi\\agent\\sessions\\one.jsonl",
            "c:/Users/u/.pi/agent/sessions/one.jsonl",
            "\\\\server\\share\\sessions\\one.jsonl",
        ] {
            assert_eq!(
                path::is_absolute_path(path).expect("absolute path"),
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
                path::is_absolute_path(path).is_err(),
                "`{path}` is relative and must not pass as absolute"
            );
        }
    }
}
