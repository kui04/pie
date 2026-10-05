//! What the frontend is told when something fails.
//!
//! An aggregation, not a taxonomy. Each layer already names its own failures,
//! and this enum holds those errors whole rather than deciding what they mean:
//! one variant per module, and no table anywhere that says which category a
//! failure belongs to. A new way to fail is a new variant in the layer that
//! owns it, and nothing here changes.
//!
//! Across the wire it is at most three fields. `type` is the module, `message` is what
//! a person reads, and `error` is the named variant underneath - `kind`, plus
//! whatever plain data that variant carries. The UI branches on `kind`, so
//! telling a refused host key from a dead socket needs nothing but the name its
//! own layer gave it.

use serde::Serialize;
use thiserror::Error;

use crate::{commands, connection, pi_rpc};

/// A failure the frontend has to handle.
///
/// Each variant carries the layer's own error boxed rather than inline: every
/// command returns this, and a boundary type that is 128 bytes to say
/// `permission denied` is paid for on every call rather than only on the
/// failures. Boxing the concrete type costs one allocation, once, when
/// something has already gone wrong.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum PieError {
    /// Reaching a host, reading what is on it, or the state of the one
    /// connection pie keeps.
    #[error("{message}")]
    Connection {
        /// What a person reads.
        message: String,
        /// The failure underneath, named.
        #[source]
        error: Box<connection::Error>,
    },

    /// The IPC layer could not do what it was asked.
    #[error("{message}")]
    Commands {
        /// What a person reads.
        message: String,
        /// The failure underneath, named.
        #[source]
        error: Box<commands::Error>,
    },

    /// Talking to pi, or to the transport under it, failed.
    #[error("{message}")]
    Rpc {
        /// What a person reads.
        message: String,
        /// The failure underneath, named.
        #[source]
        error: Box<pi_rpc::Error>,
    },

    /// A file could not be read: wrong permissions, a directory, a URI the
    /// platform will not hand over. The person did this by choosing it, and
    /// another file may read fine, so it is neither pie's bug nor the host
    /// refusing.
    #[error("{message}")]
    Io {
        /// What a person reads.
        message: String,
        /// The read itself, kept typed. `std::io::Error` names no variants of
        /// its own, so there is no `kind` to send and the words are the whole
        /// of what the frontend learns.
        #[serde(skip)]
        #[source]
        source: std::io::Error,
    },
}

impl PieError {
    /// A file that could not be read.
    ///
    /// `std::io::Error` carries no variant to name, which is why `Io` is a
    /// variant of its own rather than one more named failure inside a module:
    /// the type is the whole of the category, and the words are what the
    /// platform said about it.
    ///
    /// Built here rather than derived from the error because the two are the
    /// same failure: the sentence a person reads is the platform's own.
    pub fn file(source: std::io::Error) -> Self {
        Self::Io {
            message: source.to_string(),
            source,
        }
    }
}

impl From<connection::Error> for PieError {
    fn from(error: connection::Error) -> Self {
        Self::Connection {
            message: error.to_string(),
            error: Box::new(error),
        }
    }
}

impl From<commands::Error> for PieError {
    fn from(error: commands::Error) -> Self {
        Self::Commands {
            message: error.to_string(),
            error: Box::new(error),
        }
    }
}

impl From<pi_rpc::Error> for PieError {
    fn from(error: pi_rpc::Error) -> Self {
        Self::Rpc {
            message: error.to_string(),
            error: Box::new(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three fields that cross the wire, as the frontend receives them.
    fn crossing(error: PieError) -> serde_json::Value {
        serde_json::to_value(error).expect("serializes")
    }

    #[test]
    fn a_failure_carries_its_module_and_the_name_underneath() {
        let crossing = crossing(PieError::from(connection::Error::NotConnected {
            doing: "listing its sessions".to_string(),
        }));

        assert_eq!(crossing["type"], "connection");
        assert_eq!(crossing["error"]["kind"], "not_connected");
        assert_eq!(crossing["message"], "connect to a host before listing its sessions");
    }

    #[test]
    fn a_protocol_failure_keeps_the_name_that_reports_it() {
        let crossing = crossing(PieError::from(pi_rpc::Error::Auth {
            endpoint: "pi@host:22".to_string(),
        }));

        assert_eq!(crossing["type"], "rpc");
        assert_eq!(crossing["error"]["kind"], "auth");
        assert_eq!(crossing["message"], "the host refused the credentials for pi@host:22");
    }

    #[test]
    fn an_argument_the_ipc_layer_cannot_use_is_named_as_its_own() {
        let crossing = crossing(PieError::from(commands::Error::UnusableName { id: "a/b".to_string() }));

        assert_eq!(crossing["type"], "commands");
        assert_eq!(crossing["error"]["kind"], "unusable_name");
        assert_eq!(crossing["error"]["id"], "a/b");
    }

    #[test]
    fn a_file_that_cannot_be_read_is_the_io_category_and_says_nothing_else() {
        let crossing = crossing(PieError::file(std::io::Error::other("permission denied")));

        assert_eq!(crossing["type"], "io");
        assert_eq!(crossing["message"], "permission denied");
        assert!(
            crossing.get("error").is_none(),
            "an io failure has no variant name to report: {crossing}"
        );
    }

    #[test]
    fn every_failure_carries_a_message_a_person_can_read() {
        for error in [
            PieError::from(connection::Error::AlreadyConnected {
                endpoint: "local".to_string(),
            }),
            PieError::from(connection::Error::NoHomeDirectory),
            PieError::from(pi_rpc::Error::Closed),
            PieError::from(commands::Error::UnusableName { id: "".to_string() }),
            PieError::file(std::io::Error::other("denied")),
        ] {
            let crossing = crossing(error);
            assert!(
                crossing["message"].as_str().is_some_and(|message| !message.is_empty()),
                "got {crossing}"
            );
            assert!(
                crossing["type"].as_str().is_some_and(|module| !module.is_empty()),
                "got {crossing}"
            );
        }
    }

    #[test]
    fn a_failure_keeps_the_error_underneath_it_for_a_log_line() {
        let error = PieError::from(pi_rpc::Error::Connect {
            endpoint: "pi@host:22".to_string(),
            source: std::io::Error::other("connection refused"),
        });

        let source = std::error::Error::source(&error).expect("the protocol failure is kept");
        assert_eq!(
            source.to_string(),
            "connecting to pi@host:22 failed: connection refused"
        );
    }

    #[test]
    fn no_failure_reports_its_name_twice() {
        // A module error that only wraps another one would make serde write its
        // own `kind` and then the one inside it, and the frontend would read
        // whichever came last. Counting in the text is the only way to see it:
        // parsing into a map quietly keeps one.
        for error in [
            PieError::from(pi_rpc::Error::Auth {
                endpoint: "pi@host:22".to_string(),
            }),
            PieError::from(pi_rpc::Error::Io(std::io::Error::other("refused"))),
            PieError::from(connection::Error::AlreadyConnected {
                endpoint: "local".to_string(),
            }),
            PieError::from(connection::Error::UnreadableLocal {
                path: "/home/pie".to_string(),
                source: std::io::Error::other("denied"),
            }),
            PieError::file(std::io::Error::other("denied")),
        ] {
            let text = serde_json::to_string(&error).expect("serializes");
            assert!(
                text.matches("\"kind\":").count() <= 1,
                "the name underneath is written twice: {text}"
            );
        }
    }
}
