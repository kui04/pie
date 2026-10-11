//! Opening, reading and closing the one machine, and its directories.
//!
//! `connect` is the only command that waits for a person. Pie cannot answer one
//! question itself: whether an unknown host key belongs to the host. The question
//! arrives as an event while this command is in progress. The answer comes back
//! through a separate command. Therefore the name of the connection is an
//! argument here and not a constant: the event uses that name, and the answer
//! must say which question it answers.
//!
//! `list_dirs` is here because a directory belongs to a machine, not to a
//! session: the picker asks the connected machine, and the session that starts
//! there reads the answer.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::error::PieError;
use crate::host::{AskHostKey, ConnectionState, DirEntry, HostPath, KnownHosts, Options, PresentedKey, Spec, Trust};
use crate::session::{Id, SessionManager};

use super::Error;
use crate::state::{AppState, HOST_KEY_PATIENCE, HostKeyQuestion};

/// The event of the connection for a state.
fn state_event(connection: &Id) -> String {
    format!("pi://connection/{connection}/state")
}

/// Puts host-key questions to the frontend.
///
/// Pie builds one for each connection. Therefore the question carries the name of
/// that connection. The answer comes back through [`trust_host_key`].
struct AskFrontend {
    app: AppHandle,
    question: Arc<HostKeyQuestion>,
    connection: Id,
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

/// Connects to a machine, and reads what it holds.
///
/// No pi starts here. The connection is the machine: the reach to it and the
/// conversation files on it. A session is a pi process, and the frontend starts
/// one with [`attach_session`](crate::commands::session::attach_session) when it
/// needs to speak. Therefore a screen that only lists conversations runs no pi.
///
/// The `id` is the name of this connection from the frontend. The events of this
/// connection use that name. The host-key question arrives before this command
/// returns.
///
/// # Errors
///
/// [`Error::AlreadyConnected`] if a live connection is present,
/// [`session::Error::UnusableName`](crate::session::Error::UnusableName) if the
/// name cannot go in an event, and the failure of the reach to the machine.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(connection = %id))]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    spec: Spec,
) -> Result<crate::session::ConnectionInfo, PieError> {
    let id = Id::new(&id)?;
    let mut slot = state.sessions.lock().await;
    if let Some(existing) = slot.take() {
        if existing.is_alive() {
            let endpoint = existing.host().endpoint().to_string();
            *slot = Some(existing);
            return Err(Error::AlreadyConnected { endpoint }.into());
        }
        // No pi of this connection runs, so nothing speaks through it. The
        // connection ended with no observer, and the slot must not keep the
        // machine it reached. A machine that was connected and never spoken to is
        // this case too: only a session makes a connection live.
        tracing::info!(connection = %existing.id(), "dropping a connection with no live session");
        existing.close().await;
    }

    let home = app.path().home_dir().ok();
    let store = app
        .path()
        .app_data_dir()
        .map_err(|source| Error::NoHostKeyStore { source })?
        .join("known_hosts");
    let options = Options {
        home: home.clone(),
        trust: Trust::new(KnownHosts::new(
            store,
            home.map(|home| home.join(".ssh").join("known_hosts")),
            AskFrontend {
                app: app.clone(),
                question: Arc::clone(&state.question),
                connection: id.clone(),
            },
        )),
    };

    let sessions = SessionManager::connect(id, &spec, &options).await?;
    let info = sessions.info();
    *slot = Some(sessions);
    Ok(info)
}

/// The one connection that pie holds now, or `null` when there is none.
///
/// The workspace reads the session it subscribes to from here. The machine that
/// opened the connection dies with the connect screen, so its answer cannot
/// outlive it, and Rust is the source of truth: a reload of the webview reads the
/// same connection instead of losing it.
///
/// A connection whose pi has exited is still the connection that pie holds. The
/// read of a session reports the end; this read does not guess it.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a claim
/// about today's code. A read of the slot has nothing to fail on yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn get_connection(state: State<'_, AppState>) -> Result<Option<crate::session::ConnectionInfo>, PieError> {
    Ok(current_connection(&state).await)
}

/// What the frontend is told about the one connection, if there is one.
async fn current_connection(state: &AppState) -> Option<crate::session::ConnectionInfo> {
    let slot = state.sessions.lock().await;
    slot.as_ref().map(|sessions| sessions.info())
}

/// Ends the connection. Every session stops. The files of the sessions stay.
///
/// A disconnect with no connection does nothing. Therefore a click that races the
/// end of the connection is not an error.
///
/// A `connect` in progress holds the connection slot. Therefore this command
/// waits behind it: the version probe, the full connect to the machine, and a
/// host-key question, up to `HOST_KEY_PATIENCE`. The frontend can make the wait
/// shorter. It answers the question on screen.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a claim
/// about today's code. The end of a connection has nothing to fail on yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), PieError> {
    // The guard is dropped at the end of this block. Therefore the slot is free
    // before the sessions stop, and the shutdown below does not hold it. The order
    // of a new `connect` against this stop is the task of the frontend, not of a
    // lock.
    let sessions = {
        let mut slot = state.sessions.lock().await;
        slot.take()
    };
    if let Some(sessions) = sessions {
        sessions.close().await;
    }
    Ok(())
}

/// Answers the host-key question that the frontend shows.
///
/// `connection` receives the answer. Do not use it as a label only. A dialog that
/// stays open after a question without an answer must not answer the question
/// that replaced it. The person did not see the keys of the new question.
///
/// Returns whether a question waited for this answer. A late answer, an answer
/// for another connection, or a second answer finds no question. The function says
/// so. It does not fail.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a claim
/// about today's code. An answer has nothing to fail on yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(connection = %connection, trusted))]
pub fn trust_host_key(state: State<'_, AppState>, connection: String, trusted: bool) -> Result<bool, PieError> {
    Ok(state.question.answer(&connection, trusted))
}

/// One directory level on the connected machine, for the directory picker.
///
/// `path` is the home directory if absent. If present, `path` is an absolute path
/// on the machine. Pie resolves no relative path against its own directory. The
/// rows carry their full paths, so the picker never builds a path.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine to read, the failure of the
/// machine if pie cannot read the path, and
/// [`host::Error::NotAbsolute`](crate::host::Error::NotAbsolute) for a relative
/// path (a mistake of the frontend).
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = ?path))]
pub async fn list_dirs(state: State<'_, AppState>, path: Option<String>) -> Result<Vec<DirEntry>, PieError> {
    let sessions = state.sessions.lock().await.clone();
    let sessions = sessions.ok_or_else(|| Error::NotConnected {
        doing: "browsing its directories".to_string(),
    })?;
    let path = path.map(HostPath::new);
    Ok(sessions.host().dirs(path.as_ref()).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_connection_reads_as_none_rather_than_failing() {
        let state = AppState::default();

        assert!(
            current_connection(&state).await.is_none(),
            "no connection is a state, not a failure"
        );
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
        let connection = Id::new("main").expect("a usable name");
        question.open(&connection, answer);

        assert!(!wait_for_answer(decision, Duration::from_millis(10)).await);
        assert!(
            !question.answer("main", true),
            "a late answer finds nobody waiting, and says that it answered nothing"
        );
    }
}
