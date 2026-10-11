//! The ids of sessions, and the name of the connection that carries them.
//!
//! The frontend asks for a session by the id that the connect answered with, and
//! that id is also the name of the events of the session
//! (`pi://session/{id}/event`). Tauri refuses an event name that holds a
//! character outside letters, digits, `-`, `_`, `:` and `/`, so a name that
//! cannot be used has to be refused where a person can still be told why -
//! [`Id::new`] - and never by an event that silently goes nowhere.

use std::fmt::{Display, Formatter};

use serde::Serialize;

use super::Error;

/// The name of a connection, and the stem of the ids of its sessions.
///
/// The number that makes a session id unique is the app's: it counts the pi
/// processes one run of pie starts, so that a reconnect cannot hand the frontend
/// the events of the pi before it. See [`Id::for_session`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Id(String);

impl Id {
    /// The name a connection was given, checked for the use it is put to.
    ///
    /// # Errors
    ///
    /// [`Error::UnusableName`] when the name is empty, longer than 64 characters,
    /// or holds a character that an event name cannot carry.
    pub fn new(connection: &str) -> Result<Self, Error> {
        let usable = !connection.is_empty()
            && connection.len() <= 64
            && connection
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
        if usable {
            return Ok(Self(connection.to_string()));
        }
        Err(Error::UnusableName {
            id: connection.to_string(),
        })
    }

    /// The id of a session of this connection: the name, a colon, the number.
    ///
    /// The number only rises for the run of pie. A gap - a connect that failed
    /// took one - says nothing, and ids stay unique.
    pub fn for_session(&self, number: u64) -> Self {
        Self(format!("{}:{number}", self.0))
    }

    /// The id, as the frontend reads it.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for Id {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_name_has_to_be_usable_in_an_event() {
        for usable in ["main", "conn-1", "a_b", "x9"] {
            assert!(Id::new(usable).is_ok(), "`{usable}` should be accepted");
        }
        for unusable in ["", "a/b", "a b", "pi://connection/x", &"y".repeat(65)] {
            let error = Id::new(unusable).expect_err("this name cannot name an event");
            assert!(
                matches!(error, Error::UnusableName { .. }),
                "got {error:?} for `{unusable}`"
            );
        }
    }

    #[test]
    fn a_session_is_named_after_its_connection_and_its_number() {
        let connection = Id::new("main").expect("a usable name");

        assert_eq!(connection.for_session(1).as_str(), "main:1");
        assert_eq!(
            connection.for_session(2).as_str(),
            "main:2",
            "the second pi of a connection does not take the id of the first"
        );
    }

    #[test]
    fn the_id_of_a_session_is_usable_in_an_event() {
        // The frontend subscribes to `pi://session/{id}/...`, and Tauri refuses
        // an event name that holds a character outside letters, digits, `-`,
        // `_`, `:` and `/` (`tauri::event::event_name`).
        let connection = Id::new("conn-1_b").expect("a usable name");
        for number in [0, 1, 42, u64::MAX] {
            let id = connection.for_session(number);
            assert!(
                id.as_str()
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_-:".contains(c)),
                "`{id}` must survive as the name of an event"
            );
        }
    }

    #[test]
    fn an_id_crosses_as_the_string_the_frontend_reads() {
        let id = Id::new("main").expect("a usable name").for_session(3);

        assert_eq!(
            serde_json::to_value(&id).expect("an id serializes"),
            serde_json::json!("main:3")
        );
    }
}
