//! Opening and closing the one host.
//!
//! `connect` is the only command that waits for a person, because the only
//! question pie cannot answer itself is whether an unfamiliar host key is the
//! host's own. That question arrives as an event while this command is still
//! running, and the answer comes back through a separate command - which is why
//! the connection's name is an argument here and not a constant: the event is
//! published under it, and the answer has to say which question it answers.

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

/// The connection event a state belongs to.
fn state_event(connection: &str) -> String {
    format!("pi://connection/{connection}/state")
}

/// Puts host-key questions to the frontend.
///
/// Built per connection so that the question carries that connection's name;
/// the answer comes back through [`trust_host_key`].
struct AskFrontend {
    app: AppHandle,
    question: Arc<HostKeyQuestion>,
    connection: String,
}

impl AskHostKey for AskFrontend {
    fn ask(&self, presented: PresentedKey) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        // Taken out of `self` before the future is boxed, which borrows `self`
        // rather than them.
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

/// The answer to a host-key question, or the refusal that no answer amounts to.
///
/// Nobody answering is the case this exists for: the sender sits in the slot
/// until the question is answered or replaced, so the wait has to end by itself.
/// A frontend that went away is the same answer - no trust.
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

/// Checks the name the frontend gave a connection.
///
/// The name is part of an event - `pi://connection/{id}/state` - so it has to be
/// usable in one: a name with a slash or a space would produce an event nobody
/// could subscribe to, and the frontend would never hear the question it asked
/// for. Checking here means it hears about the mistake instead.
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

/// Connects to a host and starts its first session.
///
/// The `id` is the frontend's name for this connection: it is what the events
/// of this connection are announced under, including the host-key question that
/// arrives before this command returns.
///
/// # Errors
///
/// [`connection::Error::AlreadyConnected`] when a live connection is already
/// there, [`Error::UnusableName`] when the name cannot appear in an event, and
/// whatever reaching the host reports.
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
        // Its pi is gone: the connection it held ended without anyone watching
        // for it, and the slot should not keep it.
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

/// Ends the connection: every session stops, their files stay.
///
/// Disconnecting when nothing is connected does nothing, so a click that raced
/// the connection ending is not an error.
///
/// A `connect` in flight holds the connection slot, so this waits behind it -
/// through the version probe and the whole reach-the-host dance, and while a
/// host-key question is open, up to `HOST_KEY_PATIENCE`. The frontend can end
/// that wait sooner by answering the question it is showing.
///
/// # Errors
///
/// The result is the boundary's shape (`architecture.md`), not a claim about
/// today's code: ending a connection has nothing to fail on yet.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), PieError> {
    // The slot is released before the sessions are stopped, not after: the
    // guard is dropped at the end of this block, so the shutdown below does not
    // hold it. Whether a new `connect` may start while this one is still
    // stopping is the frontend's sequencing, not a lock's.
    let connection = {
        let mut slot = state.connection.lock().await;
        slot.take()
    };
    if let Some(connection) = connection {
        connection.disconnect().await;
    }
    Ok(())
}

/// Answers the host-key question the frontend is showing.
///
/// `connection` is the one being answered, not just a label: a dialog left open
/// by a question nobody answered must not be able to answer the question that
/// replaced it, because the keys it showed are not the keys being asked about.
///
/// Returns whether a question was waiting for this answer: a late one, one for
/// another connection, or a second one, has nothing to answer and says so
/// instead of failing.
///
/// # Errors
///
/// The result is the boundary's shape (`architecture.md`), not a claim about
/// today's code: answering has nothing to fail on yet.
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
