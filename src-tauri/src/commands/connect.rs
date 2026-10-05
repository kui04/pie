//! Opening and closing the one host.
//!
//! `connect` is the only command that waits for a person. Pie cannot answer one
//! question itself: whether an unknown host key belongs to the host. The
//! question arrives as an event while this command is in progress. The answer
//! comes back through a separate command. Therefore the name of the connection
//! is an argument here and not a constant: the event uses that name, and the
//! answer must say which question it answers.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::connection::{
    self, AskHostKey, ConnectOptions, ConnectSpec, Connection, ConnectionInfo, ConnectionState, KnownHosts,
    PresentedKey,
};
use crate::error::PieError;

use super::Error;
use super::state::{AppState, HOST_KEY_PATIENCE, HostKeyQuestion};

/// The event of the connection for a state.
fn state_event(connection: &str) -> String {
    format!("pi://connection/{connection}/state")
}

/// Puts host-key questions to the frontend.
///
/// Pie builds one for each connection. Therefore the question carries the name
/// of that connection. The answer comes back through [`trust_host_key`].
struct AskFrontend {
    app: AppHandle,
    question: Arc<HostKeyQuestion>,
    connection: String,
}

impl AskHostKey for AskFrontend {
    fn ask(&self, presented: PresentedKey) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        // These values leave `self` before the future is boxed. The future
        // borrows `self`, not the values.
        let app = self.app.clone();
        let question = Arc::clone(&self.question);
        let connection = self.connection.clone();
        let event = state_event(&connection);

        Box::pin(async move {
            let (answer, decision) = oneshot::channel();
            question.open(&connection, answer);
            if let Err(error) = app.emit(&event, ConnectionState::HostKey { key: presented }) {
                tracing::warn!(%error, "the host-key question could not be delivered");
                question.close(&connection);
                return false;
            }
            wait_for_answer(decision, HOST_KEY_PATIENCE).await
        })
    }
}

/// The answer to a host-key question. An absent answer is a refusal.
///
/// The sender stays in the slot until an answer arrives or a new question
/// replaces it. Therefore the wait must end by itself. A frontend that went away
/// gives the same answer: no trust.
async fn wait_for_answer(decision: oneshot::Receiver<bool>, patience: Duration) -> bool {
    match tokio::time::timeout(patience, decision).await {
        Ok(Ok(trusted)) => trusted,
        Ok(Err(_gone)) => false,
        Err(_elapsed) => {
            tracing::info!(?patience, "nobody answered whether to trust this host key");
            false
        }
    }
}

/// Checks the name that the frontend gave to a connection.
///
/// The name is part of an event: `pi://connection/{id}/state`. Therefore the
/// name must be usable in an event. A name with a slash or a space gives an
/// event that no listener can subscribe to. Then the frontend never hears the
/// question that it asked for. The check here gives the frontend the error
/// instead.
fn checked_id(id: &str) -> Result<(), Error> {
    let usable = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if usable {
        return Ok(());
    }
    Err(Error::UnusableName { id: id.to_string() })
}

/// Connects to a host. Starts the first session of the host.
///
/// The `id` is the name of this connection from the frontend. The events of this
/// connection use that name. The host-key question arrives before this command
/// returns.
///
/// # Errors
///
/// [`connection::Error::AlreadyConnected`] if a live connection is present,
/// [`Error::UnusableName`] if the name cannot go in an event, and the failure of
/// the reach to the host.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    spec: ConnectSpec,
) -> Result<ConnectionInfo, PieError> {
    checked_id(&id)?;
    let mut slot = state.connection.lock().await;
    if let Some(existing) = slot.as_ref() {
        if existing.is_alive() {
            return Err(connection::Error::AlreadyConnected {
                endpoint: existing.endpoint().to_string(),
            }
            .into());
        }
        // The pi of the connection is gone. The connection ended with no
        // observer. The slot must not keep it.
        tracing::info!(connection = %existing.id(), "dropping a connection whose pi has exited");
        slot.take();
    }

    let home = app.path().home_dir().ok();
    let store = app
        .path()
        .app_data_dir()
        .map_err(|source| Error::NoHostKeyStore { source })?
        .join("known_hosts");
    let options = ConnectOptions {
        home: home.clone(),
        host_key: Arc::new(KnownHosts::new(
            store,
            home.map(|home| home.join(".ssh").join("known_hosts")),
            Arc::new(AskFrontend {
                app: app.clone(),
                question: Arc::clone(&state.question),
                connection: id.clone(),
            }),
        )),
    };

    let connection = Connection::connect(id, &spec, &options).await?;
    let info = connection.info();
    *slot = Some(Arc::new(connection));
    Ok(info)
}

/// Ends the connection. Every session stops. The files of the sessions stay.
///
/// A disconnect with no connection does nothing. Therefore a click that races
/// the end of the connection is not an error.
///
/// A `connect` in progress holds the connection slot. Therefore this command
/// waits behind it: the version probe, the full connect to the host, and a
/// host-key question, up to `HOST_KEY_PATIENCE`. The frontend can make the wait
/// shorter. It answers the question on screen.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a
/// claim about today's code. The end of a connection has nothing to fail on yet.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), PieError> {
    // The guard is dropped at the end of this block. Therefore the slot is free
    // before the sessions stop, and the shutdown below does not hold it. The
    // order of a new `connect` against this stop is the task of the frontend,
    // not of a lock.
    let connection = {
        let mut slot = state.connection.lock().await;
        slot.take()
    };
    if let Some(connection) = connection {
        connection.disconnect().await;
    }
    Ok(())
}

/// Answers the host-key question that the frontend shows.
///
/// `connection` receives the answer. Do not use it as a label only. A dialog
/// that stays open after a question without an answer must not answer the
/// question that replaced it. The person did not see the keys of the new
/// question.
///
/// Returns whether a question waited for this answer. A late answer, an answer
/// for another connection, or a second answer finds no question. The function
/// says so. It does not fail.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a
/// claim about today's code. An answer has nothing to fail on yet.
#[tauri::command]
pub fn trust_host_key(state: State<'_, AppState>, connection: String, trusted: bool) -> Result<bool, PieError> {
    Ok(state.question.answer(&connection, trusted))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::PieError;
    use std::time::Duration;

    #[tokio::test]
    async fn a_question_nobody_answers_stops_waiting() {
        let (_answer, decision) = oneshot::channel();

        let trusted = wait_for_answer(decision, Duration::from_millis(10)).await;

        assert!(!trusted, "no answer is not trust");
    }

    #[tokio::test]
    async fn an_answer_that_never_arrives_does_not_hold_a_question_open() {
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open("main", answer);

        assert!(!wait_for_answer(decision, Duration::from_millis(10)).await);
        assert!(
            !question.answer("main", true),
            "a late answer finds nobody waiting, and says that it answered nothing"
        );
    }

    #[test]
    fn a_connection_name_has_to_be_usable_in_an_event() {
        for usable in ["main", "conn-1", "a_b", "x9"] {
            assert!(checked_id(usable).is_ok(), "`{usable}` should be accepted");
        }
        for unusable in ["", "a/b", "a b", "pi://connection/x", &"y".repeat(65)] {
            let error = checked_id(unusable).expect_err("`{unusable}` cannot name an event");
            assert!(
                matches!(PieError::from(error), PieError::Commands { .. }),
                "a name pie cannot use is the IPC layer's own failure"
            );
        }
    }

    #[test]
    fn a_state_event_is_named_after_its_connection() {
        assert_eq!(state_event("main"), "pi://connection/main/state");
    }
}
