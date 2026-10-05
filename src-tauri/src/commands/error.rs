//! What the IPC layer cannot do, with or without a connection.
//!
//! These failures are not about a host: an argument that pie cannot use, and a
//! directory that the platform will not name. A failure of the reach to a host
//! or of the read of a host belongs to
//! [`connection::Error`](crate::connection::Error), including the presence or
//! the absence of a connection. This module adds no wrapper. Therefore the
//! failure of a command crosses the boundary without a change.

use serde::Serialize;
use thiserror::Error;

/// A failure of the IPC layer.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// The frontend gave a name that cannot go in an event.
    #[error("`{id}` cannot name a connection: use up to 64 letters, digits, `-` and `_`")]
    UnusableName {
        /// The name from the frontend.
        id: String,
    },

    /// Pie cannot find its own directory for host keys.
    #[error("pie cannot resolve where to keep host keys: {source}")]
    NoHostKeyStore {
        /// What the platform reported. This value is not serializable.
        /// Therefore only the sentence beside it travels.
        #[serde(skip)]
        #[source]
        source: tauri::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_pie_cannot_use_says_what_one_can() {
        let error = Error::UnusableName { id: "a/b".to_string() };

        assert_eq!(
            error.to_string(),
            "`a/b` cannot name a connection: use up to 64 letters, digits, `-` and `_`"
        );
    }
}
