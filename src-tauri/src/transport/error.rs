//! Everything that can go wrong while reaching a host and starting something on
//! it.
//!
//! The variants report what happened. [`PieError`](crate::error::PieError)
//! carries this enum whole. Serde sends the name of the variant that failed as
//! `kind`, and the frontend branches on that name. The sentence for a person is
//! the task of [`Display`](std::fmt::Display). Therefore a failure has a name in
//! one place here, not in every place that reports it.
//!
//! What the protocol layer fails on - a refused command, a dropped stream, a
//! deadline - is not here: that is [`pi_rpc::Error`], with its own names. This
//! enum holds the failures of the path to the host and of the process or channel
//! that runs pi.

use std::time::Duration;

use serde::Serialize;
use thiserror::Error;

/// Result alias for the transport layer.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A failure of the path to a host, or of the peer behind it.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// The start of the peer failed (a missing binary, permission denied, ...).
    #[error("failed to start `{program}`: {source}")]
    Spawn {
        /// The program that pie started.
        program: String,
        /// The failure below.
        #[serde(skip)]
        #[source]
        source: std::io::Error,
    },

    /// An i/o operation on an open transport failed.
    #[error("transport i/o failed: {0}")]
    Io(
        #[serde(skip)]
        #[from]
        std::io::Error,
    ),

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
    fn a_source_that_is_not_plain_data_stays_on_this_side() {
        let error = Error::Spawn {
            program: "pi".to_string(),
            source: std::io::Error::other("not found"),
        };
        let crossing = serde_json::to_value(&error).expect("a failure serializes");

        assert!(
            crossing.get("source").is_none(),
            "an io::Error does not travel: {crossing}"
        );
        assert_eq!(error.to_string(), "failed to start `pi`: not found");
    }
}
