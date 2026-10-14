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
//! spellings live in `local` and `ssh`. A caller outside this module never
//! asks which machine it has.
//!
//! # Which failures come from here
//!
//! [`Error`] names what a reach or a command on the machine fails on. Starting pi
//! is the one step that meets another layer: the bytes of a started program
//! belong to [`channel`](crate::channel), so [`Host::open_pi`] hands up the
//! app's aggregation (the [`crate::error::PieError`] of the IPC boundary) rather than
//! wrapping
//! a foreign failure in one of its own. Every other entry point names its own
//! failures as [`Error`], and the caller converts.

mod error;
pub(crate) mod files;
mod local;
mod path;
mod spec;
mod ssh;
mod version;

pub use error::{Error, Result};
pub use files::DirEntry;
pub use local::LocalHost;
pub use path::HostPath;
pub use spec::{Auth, Endpoint, Options, Spec};
pub(crate) use ssh::quote;
pub use ssh::{
    AskHostKey, ExecOutput, HostKey, KnownHosts, PresentedKey, RemoteCommand, SshAuth, SshHost, SshSession, SshTarget,
    SubsystemStream, Trust,
};
pub use version::{PI_VERSION, check_version, probe_version};

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use crate::channel::Channel;
use crate::error::PieError;

/// A machine pie reaches, and the pi that runs on it.
pub enum Host {
    /// This machine. Pi is a child process here, and its sessions are files.
    Local(LocalHost),
    /// A host pie reaches over SSH. Pi runs in an exec channel, and its sessions
    /// are read over the same connection. The handle is shared because the
    /// session store reads the conversations of the same host: one reach per
    /// host, two hands on it.
    Ssh(Arc<SshHost>),
}

impl std::fmt::Debug for Host {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(local) => formatter.debug_tuple("Host::Local").field(local).finish(),
            Self::Ssh(ssh) => formatter.debug_tuple("Host::Ssh").field(ssh).finish(),
        }
    }
}

impl Host {
    /// Whether the reach to the machine is still open.
    ///
    /// The local machine cannot go away: it is this process. An SSH reach can, and
    /// its handle already knows, so nothing crosses the network to ask. Everything
    /// on an ended reach stops answering, sessions included.
    pub fn is_open(&self) -> bool {
        match self {
            Self::Local(_) => true,
            Self::Ssh(ssh) => ssh.session().is_open(),
        }
    }

    /// Reaches the machine that `spec` names, and reads the pi that runs there.
    ///
    /// The check happens before any session exists, because a `pi` that is not
    /// the release of this build may speak a protocol that pie does not know. A
    /// mismatch is not fatal: the log carries it, and a record pie does not know
    /// degrades to `Unknown` in [`pi_rpc`]. What stops a connect is a machine where
    /// `pi` cannot be read at all - there is nothing to speak to.
    ///
    /// An SSH reach can wait here for a person: a host key that is in no store
    /// goes to the frontend, and the answer arrives through a command while this
    /// call is pending.
    ///
    /// # Errors
    ///
    /// [`Error`]: a connection that could not be made, a credential that was
    /// refused, a host key that nobody trusted, and a `pi` that is missing or
    /// that cannot report its release.
    pub async fn connect(spec: &Spec, options: &Options) -> Result<Self, Error> {
        let host = match spec {
            Spec::Local => Self::Local(LocalHost::new(options.home.clone())),
            Spec::Ssh { host, port, user, auth } => {
                let mut target = SshTarget::new(host.clone(), user.clone());
                if let Some(port) = port {
                    target = target.port(*port);
                }
                // One session serves all channels on the host. Therefore the
                // version probe below needs no connection of its own.
                let session = SshSession::open(target, auth.clone().into(), options.trust.clone()).await?;
                Self::Ssh(Arc::new(SshHost::new(session)))
            }
        };

        // The `pi` of another release still speaks most of what pie knows: the log
        // carries the mismatch and the reach goes on. A machine with no `pi` at all
        // has nothing to speak to, and that failure stays.
        match host.check_pi().await {
            Ok(()) => Ok(host),
            Err(error @ Error::VersionMismatch { .. }) => {
                tracing::warn!(%error, "the pi of this machine is not the release pie speaks; going on");
                Ok(host)
            }
            Err(error) => Err(error),
        }
    }

    /// The label of this machine: `local`, or `user@host:port`.
    pub fn endpoint(&self) -> Endpoint {
        match self {
            Self::Local(_) => Endpoint::local(),
            Self::Ssh(ssh) => ssh.endpoint().clone(),
        }
    }

    /// The home directory of this machine, when it has one.
    ///
    /// A remote machine's home is the login shell's business: pie never resolves
    /// it, and the session that runs there starts where that shell starts.
    pub fn home(&self) -> Option<&Path> {
        match self {
            Self::Local(local) => local.home(),
            Self::Ssh(_) => None,
        }
    }

    /// The host over SSH, when that is what pie reached.
    pub fn ssh(&self) -> Option<&SshHost> {
        match self {
            Self::Ssh(ssh) => Some(ssh),
            Self::Local(_) => None,
        }
    }

    /// The same host, as a handle that the session layer holds for as long as the
    /// connection lives.
    pub(crate) fn ssh_handle(&self) -> Option<Arc<SshHost>> {
        match self {
            Self::Ssh(ssh) => Some(Arc::clone(ssh)),
            Self::Local(_) => None,
        }
    }

    /// Starts `pi --mode rpc` on this machine.
    ///
    /// `cwd` is the directory pi starts in, and `conversation` is a conversation
    /// file of pi to load at the start (`--session`). `None` starts a new
    /// conversation.
    ///
    /// The bytes of the started program are the channel's; everything the reach
    /// fails on is this module's. That is why this entry point hands up the
    /// aggregation rather than one layer's failures.
    ///
    /// # Errors
    ///
    /// [`PieError::Channel`] when the program cannot be started, and
    /// [`PieError::Host`] when the reach cannot open the channel it runs in.
    pub async fn open_pi(&self, cwd: Option<&HostPath>, conversation: Option<&HostPath>) -> Result<Channel, PieError> {
        match self {
            Self::Local(local) => Ok(local.open_pi(cwd, conversation)?),
            Self::Ssh(ssh) => {
                let command = RemoteCommand::new(remote_pi_line(conversation));
                let command = match cwd {
                    Some(dir) => command.cwd(dir.as_str()),
                    None => command,
                };
                Ok(ssh.session().exec(command).await?.into_channel())
            }
        }
    }

    /// Checks that the pi on this machine is the release pie speaks.
    ///
    /// # Errors
    ///
    /// [`Error::VersionProbe`] when `pi --version` cannot be read on the machine,
    /// [`Error::VersionMismatch`] when it reports another release, and
    /// [`Error::RemoteVersion`] when the probe of a host ended without printing
    /// one.
    pub async fn check_pi(&self) -> Result<()> {
        match self {
            Self::Local(local) => local.check_pi().await,
            Self::Ssh(ssh) => {
                let output = ssh.session().output(RemoteCommand::new("pi --version")).await?;
                version::check_remote_version(ssh.endpoint(), output)
            }
        }
    }

    /// One directory level of this machine, for the directory picker.
    ///
    /// `None` asks for the home directory: the home of this machine here, or the
    /// login home over sftp. Any other value must be an absolute path of the
    /// machine. Pie resolves nothing against its own directory, which on a phone
    /// is not the home of a person. The rows carry their full paths, so the
    /// picker never builds a path.
    ///
    /// # Errors
    ///
    /// [`Error::NoHomeDirectory`] when `None` is asked of a machine without one,
    /// [`Error::NotAbsolute`] for a relative path (a mistake of the frontend),
    /// and [`Error::UnreadableLocal`] or [`Error::UnreadableRemote`] when the
    /// directory cannot be read.
    pub async fn dirs(&self, path: Option<&HostPath>) -> Result<Vec<DirEntry>, Error> {
        match self {
            Self::Local(local) => files::dirs_local(local.home(), path.map(HostPath::as_str)).await,
            Self::Ssh(ssh) => {
                // A relative path is a mistake of the frontend. The report of
                // that mistake does not need an sftp handshake.
                if let Some(path) = path
                    && !path.is_absolute()
                {
                    return Err(files::not_absolute(path.as_str()));
                }
                let sftp = files::sftp(ssh).await?;
                // A failed listing must not keep a dead channel in the cache.
                match files::dirs_remote(&sftp, path.map(HostPath::as_str)).await {
                    Ok(rows) => Ok(rows),
                    Err(error) => {
                        ssh.forget_sftp(&sftp);
                        Err(error)
                    }
                }
            }
        }
    }

    /// Ends the reach: the SSH session and every channel on it.
    ///
    /// The sessions of pi stop before this, in
    /// [`SessionManager::close`](crate::session::SessionManager::close); this
    /// closes what is left. A machine that is already gone is not a failure of
    /// closing it.
    pub async fn close(&self) {
        if let Self::Ssh(ssh) = self {
            ssh.clear_sftp();
            ssh.close().await;
            tracing::info!(endpoint = %self.endpoint(), "disconnected");
        }
    }
}

/// The line that starts pi on a remote machine, conversation included.
///
/// The conversation path is quoted: it is a host path that pi wrote or that a
/// person picked, and it must not become shell syntax.
fn remote_pi_line(conversation: Option<&HostPath>) -> String {
    match conversation {
        Some(path) => format!("pi --mode rpc --session {}", quote(path.as_str())),
        None => "pi --mode rpc".to_string(),
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

    /// The local machine is this process: a reach to it cannot end, so the watch of a reach has
    /// nothing to say about it.
    #[test]
    fn the_local_machine_is_always_open() {
        assert!(Host::Local(LocalHost::new(None)).is_open());
    }

    /// The frontend tells the two things it hears on the connection channel by this tag, and the
    /// end of a reach is what the overlay of a lost link answers.
    #[test]
    fn the_end_of_a_reach_travels_under_a_tag_of_its_own() {
        assert_eq!(
            serde_json::to_value(ConnectionState::Ended).expect("an end serializes"),
            serde_json::json!({ "type": "ended" })
        );
    }

    #[test]
    fn a_remote_pi_loads_a_conversation_through_a_quoted_path() {
        assert_eq!(remote_pi_line(None), "pi --mode rpc");

        let path = HostPath::new("/home/o'brien/sessions/one.jsonl");
        assert_eq!(
            remote_pi_line(Some(&path)),
            r"pi --mode rpc --session '/home/o'\''brien/sessions/one.jsonl'"
        );
    }
}
