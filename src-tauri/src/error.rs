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
