//! What can go wrong during the connect to a host, or in the answer about the
//! state of the one connection.
//!
//! Every variant names *what happened*. It does not carry a full sentence: a
//! caller that must tell a refused host key from a dead socket matches on the
//! variant. The wording for a person is the task of
//! [`Display`](std::fmt::Display).
//!
//! This enum holds the host only. A failure of the protocol or of the transport
//! below it is a named variant of [`pi_rpc::Error`](crate::pi_rpc::Error) and reaches the boundary
//! without a change. Therefore nothing in this enum wraps it. Every variant is
//! about the one connection: the reach to a machine, or which state it is in.

use russh_sftp::client::error::Error as SftpError;
use serde::Serialize;
use thiserror::Error;

/// A failure of the one host pie talks to.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// A live connection is present.
    #[error("pie is already connected to {endpoint}")]
    AlreadyConnected {
        /// The host of the live connection, `local` or `user@host:port`.
        endpoint: String,
    },

    /// The command needs a connection. No connection is present.
    #[error("connect to a host before {doing}")]
    NotConnected {
        /// What the person tried to do. The sentence above uses it.
        doing: String,
    },

    /// The frontend named a session that this connection does not have.
    ///
    /// The ids come from the connect, which answered with the sessions of the
    /// host. An id that is gone means the frontend holds one from a connection
    /// that ended, or from a connect before the one in place.
    #[error("this connection has no session `{id}`")]
    UnknownSession {
        /// The id from the frontend, as it arrived.
        id: String,
    },

    /// `pi --version` on the host did not print a release that pie speaks.
    ///
    /// This is one variant, not one for each exit code: the sentence already
    /// holds what a person can do. The case that needs a match - a `pi` that is
    /// present but speaks another release - is
    /// [`pi_rpc::Error::VersionMismatch`](crate::pi_rpc::Error::VersionMismatch).
    /// That is a failure of the protocol layer, and it lives there.
    #[error("`pi --version` on {endpoint} {reported}")]
    RemoteVersion {
        /// The host that pie asked, `user@host:port`.
        endpoint: String,
        /// How the probe ended, and what it printed instead.
        reported: String,
    },

    /// Pie cannot read a path on this machine.
    #[error("cannot read {path}: {source}")]
    UnreadableLocal {
        /// The path at fault.
        path: String,
        /// What the read reported.
        #[serde(skip)]
        #[source]
        source: std::io::Error,
    },

    /// Pie cannot read a path on the host.
    #[error("cannot read {path}: {source}")]
    UnreadableRemote {
        /// The path at fault, as the host sees it.
        path: String,
        /// What the read reported.
        #[serde(skip)]
        #[source]
        source: SftpError,
    },

    /// The host took the request for an sftp channel. It did not open one.
    #[error("the sftp subsystem on {endpoint} did not answer: {source}")]
    SftpUnanswered {
        /// The host that went quiet, `user@host:port`.
        endpoint: String,
        /// What the handshake reported.
        #[serde(skip)]
        #[source]
        source: SftpError,
    },

    /// A relative path. Only an absolute path says something here.
    #[error("`{path}` is not absolute; pie resolves no path against its own directory")]
    NotAbsolute {
        /// The path from the frontend.
        path: String,
    },

    /// This machine has no home directory. Therefore there is nothing to browse.
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
        assert_eq!(
            Error::UnknownSession {
                id: "main:9".to_string()
            }
            .to_string(),
            "this connection has no session `main:9`"
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
