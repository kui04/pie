//! What the frontend can ask pie to do, and what it hears back.
//!
//! Every command is `snake_case` and returns `Result<T, `[`PieError`]`>`, so a
//! failure arrives as a category the UI can branch on rather than a string it
//! has to read. The rules of the boundary are in `.agents/rules/architecture.md`.
//!
//! `connect` answers with what it made; a *question* it cannot answer comes the
//! other way, as an event, because it arrives while the command is still
//! running. So the frontend names the connection it is opening (`connect` takes
//! that name) and listens on `pi://connection/{id}/state` before it calls.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::connection::{
    AskHostKey, ConnectOptions, ConnectSpec, Connection, ConnectionInfo, ConnectionState, DirEntryInfo, KnownHosts,
    PresentedKey, SessionSummary,
};
use crate::error::PieError;

/// The connection event a state belongs to.
fn state_event(connection: &str) -> String {
    format!("pi://connection/{connection}/state")
}

/// What the commands share.
///
/// One host at a time is what the product needs, so the connection is a single
/// slot, and the slot's lock is what keeps two `connect`s from racing for it.
/// The question a person is being asked lives in a lock of its own, *not*
/// inside that slot: `connect` holds the slot from the moment it starts until
/// it is connected, and on first contact it spends that time waiting for the
/// answer to exactly this question - so one lock for both would deadlock, and a
/// separate one is what lets an answer arrive while the connection is being
/// made.
#[derive(Debug, Default)]
pub struct AppState {
    /// Shared hands on the one connection: the file listings run on theirs
    /// while `connect`/`disconnect` keep the slot itself moving.
    connection: AsyncMutex<Option<Arc<Connection>>>,
    question: Arc<HostKeyQuestion>,
}

/// How long a person has to answer a host-key question.
///
/// Nothing else bounds that wait: the transport's own host-key step is
/// unbounded by design, because it is the one place a person is involved. A
/// dialog that is dismissed, or a frontend that goes away mid-question, would
/// otherwise hold `connect` - and the connection slot it locked - forever, with
/// no way out but restarting pie. Long enough to compare a fingerprint by eye.
const HOST_KEY_PATIENCE: Duration = Duration::from_secs(120);

/// The host-key question a person is being asked right now.
#[derive(Debug, Default)]
pub struct HostKeyQuestion {
    /// Which connection asked, and where its answer goes, while the question is
    /// on screen.
    waiting: Mutex<Option<(String, oneshot::Sender<bool>)>>,
}

impl HostKeyQuestion {
    /// Starts waiting for an answer from `connection`, replacing a question
    /// nobody answered.
    fn open(&self, connection: &str, answer: oneshot::Sender<bool>) {
        let replaced = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace((connection.to_string(), answer));
        if replaced.is_some() {
            tracing::warn!("a host-key question was still open; the new one replaces it");
        }
    }

    /// Stops waiting, when the question could not be put to anyone.
    ///
    /// Only this connection's question is dropped, the way only this
    /// connection's answer is taken: one connection at a time means those are
    /// always the same question today, but nothing here has to rely on that.
    fn close(&self, connection: &str) {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        if waiting.as_ref().is_some_and(|(asked, _)| asked == connection) {
            waiting.take();
        }
    }

    /// Delivers an answer, if this connection is the one waiting for one.
    ///
    /// A question that was abandoned can leave its dialog on screen, and a
    /// person clicking that one must not be answering the question that
    /// replaced it: the keys they were shown are not the keys being asked
    /// about. A mismatched answer is ignored rather than delivered, and the
    /// question it did not belong to stays open for the answer that does.
    fn answer(&self, connection: &str, trusted: bool) -> bool {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        match waiting.as_ref() {
            Some((asked, _)) if asked == connection => {}
            _ => return false,
        }
        match waiting.take() {
            Some((_, answer)) => answer.send(trusted).is_ok(),
            None => false,
        }
    }
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
fn checked_id(id: &str) -> Result<(), PieError> {
    let usable = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if usable {
        return Ok(());
    }
    Err(PieError::Internal {
        message: format!("`{id}` cannot name a connection: use up to 64 letters, digits, `-` and `_`"),
    })
}

/// Connects to a host and starts its first session.
///
/// The `id` is the frontend's name for this connection: it is what the events
/// of this connection are announced under, including the host-key question that
/// arrives before this command returns.
///
/// # Errors
///
/// [`PieError::AlreadyConnected`] when a live connection is already there,
/// otherwise whatever reaching the host reports.
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
            return Err(PieError::AlreadyConnected {
                message: format!("pie is already connected to {}", existing.endpoint()),
            });
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
        .map_err(|error| PieError::Internal {
            message: format!("pie cannot resolve where to keep host keys: {error}"),
        })?
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

/// Which kind of machine this is: `"mobile"` (no window manager) or
/// `"desktop"`.
///
/// Asked of the host rather than measured in CSS, because a phone-shaped desktop
/// window is still a desktop and a tablet in landscape is still a phone.
/// Compiled in, so it cannot change while the app runs.
///
/// # Errors
///
/// The boundary's shape, not a claim about today's code: a compiled-in fact has
/// nothing to fail on yet.
#[tauri::command]
pub fn platform() -> Result<&'static str, PieError> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return Ok("mobile");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Ok("desktop")
}

/// Every session pi has written on the connected host.
///
/// # Errors
///
/// [`PieError::NotConnected`] when there is no host to list, and whatever the
/// host reports when its sessions directory cannot be read.
#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, PieError> {
    // A shared hand, not the slot: a listing of a large remote directory runs
    // for seconds, and holding the slot that long would put `disconnect` in a
    // queue it deliberately avoids.
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| PieError::NotConnected {
        message: "connect to a host before listing its sessions".to_string(),
    })?;
    connection.list_sessions().await
}

/// One directory level on the connected host, for the directory picker.
///
/// `path` is the home directory when absent, and otherwise an absolute path
/// on the host: pie resolves no relative path against its own directory, and
/// the rows carry their whole paths so the picker never builds one.
///
/// # Errors
///
/// [`PieError::NotConnected`] when there is no host to read,
/// [`PieError::Internal`] for a relative path (the frontend's mistake), and
/// [`PieError::Transport`] when the path cannot be read.
#[tauri::command]
pub async fn list_dirs(state: State<'_, AppState>, path: Option<String>) -> Result<Vec<DirEntryInfo>, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| PieError::NotConnected {
        message: "connect to a host before browsing its directories".to_string(),
    })?;
    connection.list_dirs(path.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_answer_for_another_connection_cannot_land() {
        // An abandoned question can leave its dialog on screen; clicking it then
        // must not answer the question that replaced it, whose key the person
        // has not seen.
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open("first", answer);

        assert!(!question.answer("second", true), "that is not the connection asking");
        assert!(question.answer("first", true), "the connection that asked still can");
        assert!(decision.await.expect("the answer arrives"));
    }

    #[tokio::test]
    async fn a_question_is_only_closed_by_the_connection_that_asked_it() {
        // Symmetric with answering: dropping a question that could not be put to
        // anyone must not be able to drop somebody else's.
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open("first", answer);

        question.close("second");
        assert!(question.answer("first", true), "the question is still the first one's");
        assert!(decision.await.expect("the answer arrives"));

        let (answer, decision) = oneshot::channel();
        question.open("first", answer);
        question.close("first");
        assert!(
            decision.await.is_err(),
            "closing the question that asked drops its answer"
        );
        assert!(!question.answer("first", true), "and leaves nothing to answer");
    }

    #[test]
    fn a_connection_name_has_to_be_usable_in_an_event() {
        for usable in ["main", "conn-1", "a_b", "x9"] {
            assert!(checked_id(usable).is_ok(), "`{usable}` should be accepted");
        }
        for unusable in ["", "a/b", "a b", "pi://connection/x", &"y".repeat(65)] {
            let error = checked_id(unusable).expect_err("`{unusable}` cannot name an event");
            assert!(matches!(error, PieError::Internal { .. }), "got {error:?}");
        }
    }

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
    fn an_answer_without_a_question_has_nowhere_to_go() {
        let question = HostKeyQuestion::default();

        assert!(!question.answer("main", true), "nothing was asked");
    }

    #[tokio::test]
    async fn a_question_takes_one_answer_and_forgets_the_second() {
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open("main", answer);

        assert!(question.answer("main", true), "the waiting question was answered");
        assert!(decision.await.expect("the answer arrives"));
        assert!(!question.answer("main", false), "the second answer is late");
    }

    #[tokio::test]
    async fn a_question_nobody_answered_before_the_next_one_is_dropped() {
        let question = HostKeyQuestion::default();
        let (first, first_decision) = oneshot::channel();
        question.open("main", first);
        let (second, second_decision) = oneshot::channel();
        question.open("main", second);

        assert!(
            first_decision.await.is_err(),
            "a question that was replaced cannot be answered"
        );
        assert!(question.answer("main", true));
        assert!(second_decision.await.expect("the replacement is answered"));
    }

    #[test]
    fn a_state_event_is_named_after_its_connection() {
        assert_eq!(state_event("main"), "pi://connection/main/state");
    }

    #[test]
    fn the_platform_answers_one_of_the_two_words_the_frontend_asks_about() {
        // The only test a compiled-in fact can have: the string it answers is
        // the whole contract, and the other one is as unreachable as the mobile
        // branch it sits behind.
        let answer = platform().expect("cannot fail");
        assert!(matches!(answer, "mobile" | "desktop"), "got {answer:?}");
    }
}
