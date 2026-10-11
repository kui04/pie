//! What the session layer cannot do: name itself, or find the session that was
//! asked for.
//!
//! Both variants are about a session, not about a machine or a protocol. What
//! the reach fails on is [`host::Error`](crate::host::Error), and what pi fails
//! on is the protocol crate's own error; neither is wrapped here. Therefore a
//! command that finds a failure from below hands it up unchanged, and the
//! frontend reads the name of the layer that owns it.

use serde::Serialize;
use thiserror::Error;

/// A failure of the session layer.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// The frontend gave a name that cannot go in an event.
    ///
    /// The name of a connection becomes part of the id of its sessions, and a
    /// session id is part of the name of an event (`pi://session/{id}/event`).
    /// A name outside this character set would give an event that no listener
    /// can subscribe to, which is a mistake worth reporting rather than an error
    /// to swallow.
    #[error("`{id}` cannot name a connection: use up to 64 letters, digits, `-` and `_`")]
    UnusableName {
        /// The name from the frontend.
        id: String,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_of_a_failure_is_what_the_frontend_reads() {
        let crossing = serde_json::to_value(Error::UnknownSession {
            id: "main:9".to_string(),
        })
        .expect("a failure serializes");

        assert_eq!(crossing["kind"], "unknown_session");
        assert_eq!(crossing["id"], "main:9");
        assert_eq!(
            Error::UnknownSession {
                id: "main:9".to_string()
            }
            .to_string(),
            "this connection has no session `main:9`"
        );
    }
}
