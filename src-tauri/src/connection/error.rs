//! What can go wrong while reaching a host or answering what the state of the
//! one connection is.
//!
//! Every variant names *what happened* rather than carrying a finished
//! sentence: a caller that has to tell a refused host key from a dead socket
//! matches on it, and the wording a person reads is
//! [`Display`](std::fmt::Display)'s job.
//!
//! Only the host is here. A failure of the protocol or the transport under it
//! is already a named variant of [`pi_rpc::Error`] and reaches the boundary as
//! it is, so nothing in this enum wraps it and every variant is a failure of
//! pie's own reach for a machine.

use russh_sftp::client::error::Error as SftpError;
use serde::Serialize;
use thiserror::Error;

/// A failure of the one host pie talks to.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// A live connection is already there.
    #[error("pie is already connected to {endpoint}")]
    AlreadyConnected {
        /// Host the live connection is on, `local` or `user@host:port`.
        endpoint: String,
    },

    /// The command needs a connection and there is none.
    #[error("connect to a host before {doing}")]
    NotConnected {
        /// What the person was trying to do, phrased to finish that sentence.
        doing: String,
    },

    /// The host's `pi --version` did not print a release pie speaks.
    ///
    /// One variant rather than one per exit code, because what a person can act
    /// on is already inside the sentence; the case worth matching on - a `pi`
    /// that is there but speaks another release - is
    /// [`pi_rpc::Error::VersionMismatch`](crate::pi_rpc::Error::VersionMismatch),
    /// which is a failure of the protocol layer and lives there.
    #[error("`pi --version` on {endpoint} {reported}")]
    RemoteVersion {
        /// Host that was asked, `user@host:port`.
        endpoint: String,
        /// How the probe ended, and what it printed instead.
        reported: String,
    },

    /// A path on this machine could not be read.
    #[error("cannot read {path}: {source}")]
    UnreadableLocal {
        /// The path at fault.
        path: String,
        /// What the read reported.
        #[serde(skip)]
        #[source]
        source: std::io::Error,
    },

    /// A path on the host could not be read.
    #[error("cannot read {path}: {source}")]
    UnreadableRemote {
        /// The path at fault, as the host sees it.
        path: String,
        /// What the read reported.
        #[serde(skip)]
        #[source]
        source: SftpError,
    },

    /// The host took the request for an sftp channel and never opened one.
    #[error("the sftp subsystem on {endpoint} did not answer: {source}")]
    SftpUnanswered {
        /// Host that went quiet, `user@host:port`.
        endpoint: String,
        /// What the handshake reported.
        #[serde(skip)]
        #[source]
        source: SftpError,
    },

    /// A relative path, where only an absolute one says anything.
    #[error("`{path}` is not absolute; pie resolves no path against its own directory")]
    NotAbsolute {
        /// The path as the frontend sent it.
        path: String,
    },

    /// This machine has no home directory, so there is nothing to browse.
    #[error("there is no home directory on this machine to browse")]
    NoHomeDirectory,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_of_the_one_connection_is_named_here() {
        assert_eq!(
            Error::AlreadyConnected {
                endpoint: "local".to_string()
            }
            .to_string(),
            "pie is already connected to local"
        );
        assert_eq!(
            Error::NotConnected {
                doing: "listing its sessions".to_string()
            }
            .to_string(),
            "connect to a host before listing its sessions"
        );
    }

    #[test]
    fn a_path_that_cannot_be_read_says_which_one() {
        let error = Error::UnreadableLocal {
            path: "/home/pie/.pi".to_string(),
            source: std::io::Error::other("permission denied"),
        };

        assert_eq!(error.to_string(), "cannot read /home/pie/.pi: permission denied");
        assert!(std::error::Error::source(&error).is_some(), "the refusal survives");
    }
}
