//! The failure a command returns to the frontend.

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

/// A failure at the IPC boundary.
///
/// A variant exists only for a failure this boundary decides itself: the state
/// of a connection, an argument it cannot use, an operation the platform does
/// not support, a link it will not open. Everything that a machine, a program,
/// or the protocol failed on is [`PieError::Failed`], one sentence with the
/// chain of causes behind it.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PieError {
    #[error("pie already holds a connection named `{connection}`")]
    AlreadyConnected { connection: String },

    #[error("connect to a host before {doing}")]
    NotConnected { doing: String },

    #[error("no pi runs on `{session}`; attach the conversation first")]
    NotAttached { session: String },

    #[error("invalid argument: {reason}")]
    BadArgument { reason: String },

    #[error("{what} is not supported")]
    NotSupported { what: String },

    #[error("`{url}` is not a link pie opens")]
    UnopenableUrl { url: String },

    #[error("{0:#}")]
    Failed(#[from] anyhow::Error),
}

impl PieError {
    /// A failure that has no name of this boundary.
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(anyhow::Error::msg(message.into()))
    }

    /// The name the frontend matches.
    fn name(&self) -> &'static str {
        match self {
            Self::AlreadyConnected { .. } => "already_connected",
            Self::NotConnected { .. } => "not_connected",
            Self::NotAttached { .. } => "not_attached",
            Self::BadArgument { .. } => "bad_argument",
            Self::NotSupported { .. } => "not_supported",
            Self::UnopenableUrl { .. } => "unopenable_url",
            Self::Failed(_) => "failed",
        }
    }

    /// The fields of a named failure, beside its name and its sentence.
    fn details(&self) -> Vec<(&'static str, &str)> {
        match self {
            Self::AlreadyConnected { connection } => vec![("connection", connection)],
            Self::NotConnected { doing } => vec![("doing", doing)],
            Self::NotAttached { session } => vec![("session", session)],
            Self::BadArgument { reason } => vec![("reason", reason)],
            Self::NotSupported { what } => vec![("what", what)],
            Self::UnopenableUrl { url } => vec![("url", url)],
            Self::Failed(_) => Vec::new(),
        }
    }
}

impl Serialize for PieError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", self.name())?;
        map.serialize_entry("message", &self.to_string())?;
        for (key, value) in self.details() {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl From<std::io::Error> for PieError {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.into())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn every_named_failure_keeps_its_kind_and_its_field() {
        let cases = [
            (
                PieError::AlreadyConnected {
                    connection: "work".to_owned(),
                },
                json!({
                    "kind": "already_connected",
                    "message": "pie already holds a connection named `work`",
                    "connection": "work",
                }),
            ),
            (
                PieError::NotConnected {
                    doing: "reaching host `work`".to_owned(),
                },
                json!({
                    "kind": "not_connected",
                    "message": "connect to a host before reaching host `work`",
                    "doing": "reaching host `work`",
                }),
            ),
            (
                PieError::NotAttached {
                    session: "/work/a.jsonl".to_owned(),
                },
                json!({
                    "kind": "not_attached",
                    "message": "no pi runs on `/work/a.jsonl`; attach the conversation first",
                    "session": "/work/a.jsonl",
                }),
            ),
            (
                PieError::BadArgument {
                    reason: "the path is relative".to_owned(),
                },
                json!({
                    "kind": "bad_argument",
                    "message": "invalid argument: the path is relative",
                    "reason": "the path is relative",
                }),
            ),
            (
                PieError::NotSupported {
                    what: "a directory picker".to_owned(),
                },
                json!({
                    "kind": "not_supported",
                    "message": "a directory picker is not supported",
                    "what": "a directory picker",
                }),
            ),
            (
                PieError::UnopenableUrl {
                    url: "file:///etc/passwd".to_owned(),
                },
                json!({
                    "kind": "unopenable_url",
                    "message": "`file:///etc/passwd` is not a link pie opens",
                    "url": "file:///etc/passwd",
                }),
            ),
        ];

        for (error, wire) in cases {
            assert_eq!(
                serde_json::to_value(&error).expect("a failure serializes"),
                wire,
                "{error}"
            );
        }
    }

    #[test]
    fn a_failure_without_a_name_keeps_its_causes_outermost_first() {
        let error = PieError::Failed(
            anyhow::anyhow!("the program ended").context("running `pi --version`"),
        );

        assert_eq!(
            serde_json::to_value(&error).expect("a failure serializes"),
            json!({
                "kind": "failed",
                "message": "running `pi --version`: the program ended",
            })
        );
    }

    #[test]
    fn a_failure_of_this_boundary_is_the_failed_kind() {
        let error = PieError::failed("no pi runs there");

        assert_eq!(
            serde_json::to_value(&error).expect("a failure serializes"),
            json!({ "kind": "failed", "message": "no pi runs there" })
        );
    }

    #[test]
    fn an_io_failure_keeps_its_message() {
        let error = PieError::from(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such file",
        ));

        let wire = serde_json::to_value(&error).expect("a failure serializes");
        assert_eq!(wire["kind"], "failed");
        assert!(
            wire["message"]
                .as_str()
                .expect("a message")
                .contains("no such file"),
            "{wire}"
        );
    }
}
