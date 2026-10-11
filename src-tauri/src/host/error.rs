//! What can go wrong while reaching a machine, and while pie works on it
//! outside pi.
//!
//! The variants report what happened. [`PieError`](crate::error::PieError)
//! carries this enum whole. Serde sends the name of the variant that failed as
//! `kind`, and the frontend shows the sentence [`Display`](std::fmt::Display)
//! wrote. The name travels beside it, for logs and for matching. Therefore a failure has a name in
//! one place here, not in every place that reports it.
//!
//! Three groups live here, and each names its own shape:
//!
//! - the reach: the socket, the SSH layer, the credentials, the host key;
//! - what runs on the machine beside pi: a command, a subsystem, the version of
//!   the pi that is installed there;
//! - the files of the machine, which is why the path failures are here and not
//!   in [`session`](crate::session) - the layer that reads a path names it, and
//!   a caller that borrows the read borrows the failure with it.
//!
//! What the bytes of a started program fail on is not here: that is
//! [`channel::Error`](crate::channel::Error). What the protocol fails on is
//! `pi_rpc`'s own error. Neither is wrapped by this enum.

use std::time::Duration;

use russh_sftp::client::error::Error as SftpError;
use serde::Serialize;
use thiserror::Error;

/// Result alias for the host layer.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A failure of the reach to a machine, or of pie's work on it.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// The host did not accept the TCP connection in the time limit.
    #[error("connecting to {endpoint} timed out after {timeout:?}")]
    ConnectTimeout {
        /// The host that pie tried to reach, `user@host:port`.
        endpoint: String,
        /// The limit that expired.
        timeout: Duration,
    },

    /// The TCP connection to the host failed.
    #[error("connecting to {endpoint} failed: {source}")]
    Connect {
        /// Host that was being reached, `user@host:port`.
        endpoint: String,
        /// Underlying failure.
        #[serde(skip)]
        #[source]
        source: std::io::Error,
    },

    /// The SSH layer failed: the handshake, a channel, or the session.
    #[error("ssh: {0}")]
    Ssh(
        #[serde(skip)]
        #[from]
        russh::Error,
    ),

    /// Pie cannot decode or decrypt a private key.
    #[error("reading the private key: {source}")]
    SshKey {
        /// The reason for the failure.
        #[serde(skip)]
        #[source]
        source: russh::keys::Error,
    },

    /// The host refused the credentials.
    #[error("the host refused the credentials for {endpoint}")]
    Auth {
        /// The host that refused them, `user@host:port`.
        endpoint: String,
    },

    /// The host did not accept and did not refuse the credentials.
    #[error("{endpoint} did not answer within {timeout:?}")]
    AuthTimeout {
        /// The host with no answer, `user@host:port`.
        endpoint: String,
        /// The limit that expired.
        timeout: Duration,
    },

    /// Pie did not accept the key of the host. Therefore the handshake stopped.
    #[error("the host key of {endpoint} was not accepted: {reason}")]
    HostKeyRejected {
        /// The host whose key pie refused, as `host:port`. Pie checks the host,
        /// not the login name. Therefore the policy of the app has no login
        /// name here, unlike [`Error::Connect`].
        endpoint: String,
        /// The reason for the refusal, in words for a person.
        reason: String,
    },

    /// The host refused to run the command. A missing `pi` is the usual cause.
    #[error("{endpoint} refused to run `{command}`")]
    Exec {
        /// The host that refused, `user@host:port`.
        endpoint: String,
        /// The command as pie sent it.
        command: String,
    },

    /// The host accepted the connection and gave no answer about the command.
    #[error("{endpoint} did not answer within {timeout:?} whether it can run `{command}`")]
    ExecTimeout {
        /// The host that stayed silent, `user@host:port`.
        endpoint: String,
        /// The command as pie sent it.
        command: String,
        /// The limit that expired.
        timeout: Duration,
    },

    /// The host refused to start a subsystem on a channel. An sshd without
    /// `sftp` on its `Subsystem` line is the usual cause.
    #[error("{endpoint} refused to start the `{name}` subsystem")]
    Subsystem {
        /// The host that refused, `user@host:port`.
        endpoint: String,
        /// The subsystem name as pie asked for it, for example `sftp`.
        name: String,
    },

    /// The host accepted the connection and gave no answer about the subsystem.
    #[error("{endpoint} did not answer within {timeout:?} whether it will start the `{name}` subsystem")]
    SubsystemTimeout {
        /// The host that stayed silent, `user@host:port`.
        endpoint: String,
        /// The subsystem name as pie asked for it, for example `sftp`.
        name: String,
        /// The limit that expired.
        timeout: Duration,
    },

    /// `<program> --version` failed, or printed nothing usable.
    #[error("`{program} --version` failed: {message}")]
    VersionProbe {
        /// The program that pie probed.
        program: String,
        /// The failure, or the value that it printed instead.
        message: String,
    },

    /// The `pi` binary is not the release that pie mirrors.
    #[error("pi version mismatch: expected {expected}, found {found}")]
    VersionMismatch {
        /// Version pie mirrors.
        expected: String,
        /// Version reported by the probed binary.
        found: String,
    },

    /// `pi --version` on the host did not print a release that pie speaks.
    ///
    /// This is one variant, not one for each exit code: the sentence already
    /// holds what a person can do. The case that needs a match - a `pi` that is
    /// present but speaks another release - is [`Error::VersionMismatch`].
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
    fn the_name_of_a_failure_is_what_the_frontend_reads() {
        let crossing = serde_json::to_value(Error::Auth {
            endpoint: "pi@host:22".to_string(),
        })
        .expect("a failure serializes");

        assert_eq!(crossing["kind"], "auth");
        assert_eq!(crossing["endpoint"], "pi@host:22");
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
