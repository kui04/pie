//! What the frontend is told when something fails.
//!
//! The boundary has a name only for the failures that pie itself decides: the
//! state of its one connection, an argument it cannot use, an operation this
//! platform does not support, and a link it will not open. Everything a machine,
//! a program, or the protocol failed on is [`PieError::Failed`]: a sentence with
//! the chain of causes behind it, built where the failure happened. No table
//! turns one layer's failure into another's category.
//!
//! Across the wire the value is one object. `kind` is the name of the failure
//! (`failed` when it has no name of its own), `message` is the sentence a person
//! reads, and the fields of the named variants travel beside them. The frontend
//! shows the sentence and matches the name when it must.

use serde::Serialize;
use serde::ser::SerializeMap;

/// A failure that the frontend must handle.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PieError {
    /// A live connection is present, and the product keeps one at a time.
    #[error("pie is already connected to {endpoint}")]
    AlreadyConnected {
        /// The machine of the live connection, `local` or `user@host:port`.
        endpoint: String,
    },

    /// The command needs a connection. No connection is present.
    #[error("connect to a host before {doing}")]
    NotConnected {
        /// What the person tried to do. The sentence above uses it.
        doing: String,
    },

    /// An argument that pie cannot use or parse.
    #[error("invalid argument: {reason}")]
    BadArgument {
        /// Why the argument cannot be used.
        reason: String,
    },

    /// An operation that the platform or configuration does not support.
    #[error("{what} is not supported")]
    NotSupported {
        /// What was attempted.
        what: String,
    },

    /// A link pie will not open: not a link, or a scheme it does not trust.
    #[error("`{url}` is not a link pie opens")]
    UnopenableUrl {
        /// The address, as short as a sentence can hold it.
        url: String,
    },

    /// Everything a machine, a program, or the protocol failed on.
    ///
    /// The sentence is the chain of contexts, outermost first (`{:#}`), so a
    /// person reads what pie was doing and why it stopped. The failure carries no
    /// name of its own: `kind` says `failed`, and the sentence is the report.
    #[error("{0:#}")]
    Failed(#[from] anyhow::Error),
}

impl PieError {
    /// A failure whose sentence is the whole story.
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(anyhow::Error::msg(message.into()))
    }

    /// The name the frontend reads.
    fn kind(&self) -> &'static str {
        match self {
            Self::AlreadyConnected { .. } => "already_connected",
            Self::NotConnected { .. } => "not_connected",
            Self::BadArgument { .. } => "bad_argument",
            Self::NotSupported { .. } => "not_supported",
            Self::UnopenableUrl { .. } => "unopenable_url",
            Self::Failed(_) => "failed",
        }
    }
}

impl From<std::io::Error> for PieError {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.into())
    }
}

impl Serialize for PieError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", self.kind())?;
        map.serialize_entry("message", &self.to_string())?;
        match self {
            Self::AlreadyConnected { endpoint } => map.serialize_entry("endpoint", endpoint)?,
            Self::NotConnected { doing } => map.serialize_entry("doing", doing)?,
            Self::BadArgument { reason } => map.serialize_entry("reason", reason)?,
            Self::NotSupported { what } => map.serialize_entry("what", what)?,
            Self::UnopenableUrl { url } => map.serialize_entry("url", url)?,
            Self::Failed(_) => {}
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fields that cross the wire, as the frontend receives them.
    fn crossing(error: PieError) -> serde_json::Value {
        serde_json::to_value(error).expect("serializes")
    }

    #[test]
    fn a_named_failure_carries_its_name_its_sentence_and_its_fields() {
        let crossing = crossing(PieError::NotConnected {
            doing: "listing its sessions".to_string(),
        });

        assert_eq!(crossing["kind"], "not_connected");
        assert_eq!(crossing["message"], "connect to a host before listing its sessions");
        assert_eq!(crossing["doing"], "listing its sessions");
    }

    #[test]
    fn a_failure_without_a_name_is_failed_and_keeps_the_chain() {
        let error = anyhow::anyhow!("permission denied").context("cannot read /home/pie/.pi");

        let crossing = crossing(PieError::from(error));

        assert_eq!(crossing["kind"], "failed");
        assert_eq!(crossing["message"], "cannot read /home/pie/.pi: permission denied");
        assert!(
            crossing.get("reason").is_none(),
            "a failure with no name carries no fields of its own: {crossing}"
        );
    }

    #[test]
    fn a_file_that_cannot_be_read_is_the_sentence_of_the_platform() {
        let crossing = crossing(PieError::from(std::io::Error::other("permission denied")));

        assert_eq!(crossing["kind"], "failed");
        assert_eq!(crossing["message"], "permission denied");
    }

    #[test]
    fn a_protocol_failure_keeps_the_sentence_the_layer_wrote() {
        let error = anyhow::Error::new(pi_rpc::error::Error::new(
            pi_rpc::error::ErrorKind::Closed,
            "transport ended",
        ))
        .context("reading the state of a session");

        let crossing = crossing(PieError::from(error));

        assert_eq!(crossing["kind"], "failed");
        assert_eq!(
            crossing["message"],
            "reading the state of a session: closed: transport ended"
        );
    }

    #[test]
    fn every_failure_carries_a_message_a_person_can_read() {
        for error in [
            PieError::AlreadyConnected {
                endpoint: "local".to_string(),
            },
            PieError::NotConnected {
                doing: "reading a session".to_string(),
            },
            PieError::BadArgument {
                reason: "a path is relative".to_string(),
            },
            PieError::NotSupported {
                what: "folder picking on mobile".to_string(),
            },
            PieError::UnopenableUrl {
                url: "javascript:alert(1)".to_string(),
            },
            PieError::failed("denied"),
        ] {
            let crossing = crossing(error);
            assert!(
                crossing["message"].as_str().is_some_and(|message| !message.is_empty()),
                "got {crossing}"
            );
            assert!(
                crossing["kind"].as_str().is_some_and(|kind| !kind.is_empty()),
                "got {crossing}"
            );
        }
    }

    /// The frontend logs a failure of Tauri itself by its shape: a string, or an
    /// object without a name. Every failure of this boundary is an object with
    /// one, and with one `kind` only.
    #[test]
    fn no_failure_reports_its_name_twice() {
        for error in [
            PieError::AlreadyConnected {
                endpoint: "local".to_string(),
            },
            PieError::NotConnected {
                doing: "reading a session".to_string(),
            },
            PieError::BadArgument {
                reason: "x".to_string(),
            },
            PieError::NotSupported {
                what: "folder picking on mobile".to_string(),
            },
            PieError::UnopenableUrl {
                url: "file:///etc/passwd".to_string(),
            },
            PieError::failed("denied"),
        ] {
            let text = serde_json::to_string(&error).expect("serializes");
            assert!(
                text.matches("\"kind\":").count() == 1,
                "the name is written twice: {text}"
            );
        }
    }

    #[test]
    fn a_failure_is_failed_only_when_it_has_no_name() {
        let anonymous = crossing(PieError::failed("denied"));
        let named = crossing(PieError::BadArgument {
            reason: "x".to_string(),
        });

        assert_eq!(anonymous["kind"], "failed");
        assert_eq!(named["kind"], "bad_argument");
    }
}
