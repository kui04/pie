//! What a session of pi holds.
//!
//! Three reads for the read-only workspace: the state of a session, its
//! transcript, and its usage. Each one names its session, because one connection
//! can hold more than one.
//!
//! The argument is named `session` because that is the name of the argument that
//! the frontend sends. Its value is the id of the session, the one that
//! `ConnectionInfo.sessions[].id` carries. That id is pie's own (`main:1`); it is
//! not the session id of pi, which is the id of the session file.
//!
//! A read runs on a shared hand, not on the connection slot. The slot must stay
//! free for `disconnect`.
//!
//! A read fails as the layer that owns the failure: an absent connection or an
//! absent session is [`connection::Error`], and everything below them is
//! [`crate::pi_rpc::Error`]. Neither is wrapped here.

use tauri::State;

use crate::connection;
use crate::error::PieError;
use crate::pi_rpc::protocol::{EntriesData, SessionState, SessionStats};

use super::state::AppState;

/// The state of one session: its model, its run, its name, its counts.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] if there is no host, and
/// [`connection::Error::UnknownSession`] if the id belongs to no session of this
/// connection. The failure of the read itself is the failure of the protocol.
#[tauri::command]
pub async fn get_state(state: State<'_, AppState>, session: String) -> Result<SessionState, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| connection::Error::NotConnected {
        doing: "reading the state of a session".to_string(),
    })?;
    connection
        .session(&session)
        .ok_or_else(|| connection::Error::UnknownSession { id: session.clone() })?
        .state()
        .await
}

/// Every entry of one session, and the leaf it points at.
///
/// The entries are the raw set: other branches of a fork are in it, and the
/// entries that a compaction summarized stay in it. The frontend builds the view
/// of the transcript from this.
///
/// # Errors
///
/// The same as [`get_state`], and the failure of the protocol.
#[tauri::command]
pub async fn get_entries(state: State<'_, AppState>, session: String) -> Result<EntriesData, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| connection::Error::NotConnected {
        doing: "reading the transcript of a session".to_string(),
    })?;
    connection
        .session(&session)
        .ok_or_else(|| connection::Error::UnknownSession { id: session.clone() })?
        .entries()
        .await
}

/// The usage of one session: its counts, its tokens, its cost, its context.
///
/// # Errors
///
/// The same as [`get_state`], and the failure of the protocol.
#[tauri::command]
pub async fn get_session_stats(state: State<'_, AppState>, session: String) -> Result<SessionStats, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| connection::Error::NotConnected {
        doing: "reading the usage of a session".to_string(),
    })?;
    connection
        .session(&session)
        .ok_or_else(|| connection::Error::UnknownSession { id: session.clone() })?
        .stats()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_that_is_not_there_fails_as_the_connection_layer() {
        // The frontend matches on the pair below. The name of the layer says
        // which part of pie failed: this one is not the protocol.
        let error = PieError::from(connection::Error::UnknownSession {
            id: "main:9".to_string(),
        });
        let sent = serde_json::to_value(&error).expect("a failure serializes");

        assert_eq!(sent["type"], "connection");
        assert_eq!(sent["error"]["kind"], "unknown_session");
        assert_eq!(sent["message"], "this connection has no session `main:9`");
    }
}
