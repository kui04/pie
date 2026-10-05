//! What the IPC layer cannot do, whatever host is or is not connected.
//!
//! The failures that are not about a host at all: an argument pie cannot use,
//! and a directory the platform will not name. Everything about reaching or
//! reading a host belongs to [`connection::Error`](crate::connection::Error),
//! including whether a connection is there at all - this module adds no
//! wrapper of its own, so a command's own failure is the one that crosses the
//! boundary unchanged.

use serde::Serialize;
use thiserror::Error;

/// A failure of the IPC layer.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// The name the frontend gave a connection cannot appear in an event.
    #[error("`{id}` cannot name a connection: use up to 64 letters, digits, `-` and `_`")]
    UnusableName {
        /// The name as the frontend sent it.
        id: String,
    },

    /// Pie's own directory for host keys cannot be resolved.
    #[error("pie cannot resolve where to keep host keys: {source}")]
    NoHostKeyStore {
        /// What the platform reported. Not serializable, so only the sentence
        /// beside it travels.
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
