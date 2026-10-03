//! What the frontend is told when something fails.
//!
//! The category is the point: React branches on [`PieError`]'s tag (a wrong
//! password is a different screen than a host that moved), so the five
//! categories the architecture fixes stay separate and a failure is never
//! flattened into a string. Each variant still carries the message a person
//! reads, built once where the failure is known.
//!
//! `pi_rpc` reports what happened in its own terms; this module is where those
//! terms become the boundary taxonomy, so the mapping lives in one place.

use serde::Serialize;

/// A failure the frontend has to handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PieError {
    /// The connection itself failed: a socket, a channel, an unreadable
    /// stream - or the channel to pi ended under a command, which is what a
    /// frontend should offer to retry rather than send someone looking for a
    /// missing binary.
    Transport { message: String },
    /// The host would not accept who pie said it was.
    Auth { message: String },
    /// The host is not the machine the user meant to reach.
    HostKey { message: String },
    /// `pi` is not there, not runnable, or not the release pie speaks.
    Process { message: String },
    /// Pi answered a command with a refusal.
    Rpc { message: String },
    /// A live connection is already there.
    AlreadyConnected { message: String },
    /// The command needs a live connection and there is none.
    NotConnected { message: String },
    /// Pie's own side got something wrong: a path it needs, a record it wrote,
    /// or an argument from its own frontend. Nothing the user did and nothing
    /// the host did.
    Internal { message: String },
}

impl std::fmt::Display for PieError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Transport { message }
            | Self::Auth { message }
            | Self::HostKey { message }
            | Self::Process { message }
            | Self::Rpc { message }
            | Self::AlreadyConnected { message }
            | Self::NotConnected { message }
            | Self::Internal { message } => message,
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for PieError {}

impl From<crate::pi_rpc::Error> for PieError {
    /// Sorts one protocol-layer failure into the boundary taxonomy.
    ///
    /// Every variant is listed rather than caught by a catch-all: `pi_rpc` and
    /// this module are one crate, so `#[non_exhaustive]` buys nothing here and a
    /// new way to fail should stop this from compiling until it is sorted.
    fn from(error: crate::pi_rpc::Error) -> Self {
        use crate::pi_rpc::Error;

        let message = error.to_string();
        match error {
            // No pi to run, or the one there is speaking a protocol pie does
            // not know; `Exec` is the host refusing to run the command at all,
            // whose commonest cause is a `pi` that is not on its PATH.
            Error::Spawn { .. }
            | Error::VersionProbe { .. }
            | Error::VersionMismatch { .. }
            | Error::Exec { .. }
            | Error::ExecTimeout { .. } => Self::Process { message },
            // Pi answered a command with a refusal, did not answer it, or
            // answered it in a shape pie does not know.
            Error::Rpc { .. } | Error::Timeout { .. } | Error::Payload { .. } => Self::Rpc { message },
            // A private key that cannot be read is part of authenticating.
            Error::SshKey { .. } | Error::Auth { .. } | Error::AuthTimeout { .. } => Self::Auth { message },
            Error::HostKeyRejected { .. } => Self::HostKey { message },
            // Reaching the host at all, and staying reached: socket, handshake,
            // channel, stream. A refused or silent subsystem belongs here too:
            // the host serves no such channel, which is about the reach, not
            // about pi being installed.
            Error::Io(_)
            | Error::Connect { .. }
            | Error::ConnectTimeout { .. }
            | Error::Ssh(_)
            | Error::Subsystem { .. }
            | Error::SubsystemTimeout { .. } => Self::Transport { message },
            // The channel to pi was gone when a command went out: pie was
            // shutting down, or pi had exited. That is a connection that ended,
            // not a machine with no pi on it - sending this one to `Process`
            // would tell the user to go and install something that is already
            // there.
            Error::Closed => Self::Transport { message },
            // Bugs, or a setup pie depends on: never the host's doing.
            Error::Encode(_) | Error::NoRuntime => Self::Internal { message },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi_rpc::Error;

    #[test]
    fn the_categories_stay_apart() {
        let cases = [
            (
                Error::Auth {
                    endpoint: "pi@host:22".into(),
                },
                "auth",
            ),
            (
                Error::HostKeyRejected {
                    endpoint: "host:22".into(),
                    reason: "changed".into(),
                },
                "host_key",
            ),
            (Error::NoRuntime, "internal"),
            (
                Error::VersionMismatch {
                    expected: "0.99.2".into(),
                    found: "0.84.2".into(),
                },
                "process",
            ),
            // A host that will not run the command has no pi to run, which is
            // about the process it was asked for, not the transport it arrived
            // on.
            (
                Error::Exec {
                    endpoint: "pi@host:22".into(),
                    command: "pi --mode rpc".into(),
                },
                "process",
            ),
            // The channel ended under a command. Told apart from the cases above
            // on purpose: `pi` is installed and current, it is the connection
            // that is gone, and the frontend should offer a retry rather than go
            // looking for a binary.
            (Error::Closed, "transport"),
            // The host serves no such channel. About the reach, not about pi:
            // `sftp` missing from the sshd's `Subsystem` line sends someone to
            // the host's sshd configuration, never to a `pi` installer.
            (
                Error::Subsystem {
                    endpoint: "pi@host:22".into(),
                    name: "sftp".into(),
                },
                "transport",
            ),
            (
                Error::Rpc {
                    command: "compact".into(),
                    message: "no".into(),
                },
                "rpc",
            ),
            (
                Error::Connect {
                    endpoint: "pi@host:22".into(),
                    source: std::io::Error::other("refused"),
                },
                "transport",
            ),
        ];

        for (error, expected) in cases {
            let tagged = serde_json::to_value(PieError::from(error)).expect("serializes");
            assert_eq!(tagged["type"], expected, "got {tagged}");
            assert!(
                tagged["message"].as_str().is_some_and(|message| !message.is_empty()),
                "every failure carries something to show: {tagged}"
            );
        }
    }

    #[test]
    fn the_app_says_when_the_connection_slot_is_empty() {
        // No protocol failure maps onto these: they are about pie's own state.
        for (error, expected) in [
            (
                PieError::AlreadyConnected {
                    message: "a connection is live".to_string(),
                },
                "already_connected",
            ),
            (
                PieError::NotConnected {
                    message: "connect first".to_string(),
                },
                "not_connected",
            ),
        ] {
            let tagged = serde_json::to_value(&error).expect("serializes");
            assert_eq!(tagged["type"], expected, "got {tagged}");
        }
    }

    #[test]
    fn a_mismatch_still_reads_well_to_a_person() {
        let error = PieError::from(Error::VersionMismatch {
            expected: "0.99.2".into(),
            found: "0.84.2".into(),
        });

        assert_eq!(error.to_string(), "pi version mismatch: expected 0.99.2, found 0.84.2");
    }
}
