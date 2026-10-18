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
use crate::host::{AskHostKey, ConnectionState, HostPath, KnownHosts, Listing, Options, PresentedKey, Spec, Trust};
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

    let sessions = dial(&app, &state, &id, spec).await?;
    let info = sessions.info();
    *slot = Some(sessions.clone());
    watching(&app, sessions, id);
    Ok(info)
}

/// The options of a reach: what the machine is, and where its host keys are kept.
///
/// Built per dial rather than kept, because a host-key question carries the name of
/// the connection it belongs to: an answer to the question of a connection that is
/// gone must answer nothing.
fn reach_options(app: &AppHandle, state: &AppState, id: &Id) -> Result<Options, PieError> {
    let home = app.path().home_dir().ok();
    let store = app
        .path()
        .app_data_dir()
        .map_err(|source| Error::NoHostKeyStore { source })?
        .join("known_hosts");
    Ok(Options {
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
    })
}

/// Reaches the machine of `spec`, and reads what it holds.
///
/// The watch of the reach starts after the connection is in the slot and not here: a
/// watch of a connection that is not there has nothing to report.
async fn dial(app: &AppHandle, state: &AppState, id: &Id, spec: Spec) -> Result<SessionManager, PieError> {
    let options = reach_options(app, state, id)?;
    SessionManager::connect(id.clone(), &spec, &options).await
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

/// Brings the connection back, with what this process already holds.
///
/// A reach ends on its own: a network goes away, a host sleeps. The frontend hears the
/// end, and this is the command it answers it with. The machine, the address and the
/// credential are the ones already used in this process, so a person types nothing a
/// second time, and no secret crosses the boundary again - not even to pie's own
/// frontend.
///
/// The connection that ended stays in the slot until a new one answers it. A dial that
/// fails must leave the retry able to try again: the spec in the slot is the only way back
/// to the machine, and a frontend that finds no connection at all leaves for the gate.
/// The slot is held from the start of the dial, as `connect` holds it, so a `connect` and a
/// `reconnect` cannot both take the machine.
///
/// # Errors
///
/// [`Error::NotConnected`] when there is no connection to bring back - what a request
/// that raced the end of a connection finds - and everything a `connect` reports.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn reconnect(app: AppHandle, state: State<'_, AppState>) -> Result<crate::session::ConnectionInfo, PieError> {
    let mut slot = state.sessions.lock().await;
    let Some(previous) = slot.as_ref() else {
        return Err(Error::NotConnected {
            doing: "bringing the connection back".to_string(),
        }
        .into());
    };

    let id = previous.id().clone();
    let spec = previous.spec().clone();
    tracing::info!(connection = %id, endpoint = %previous.host().endpoint(), "dialling the same machine again");

    let sessions = match dial(&app, &state, &id, spec).await {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(connection = %id, %error, "the connection could not be brought back");
            return Err(error);
        }
    };
    let info = sessions.info();
    let ended = slot.replace(sessions.clone());
    watching(&app, sessions, id);
    if let Some(ended) = ended {
        // The reach of that one is gone and its pi processes with it. Nothing speaks through
        // it any more, and the slot now holds the connection that answered.
        ended.close().await;
    }
    Ok(info)
}

/// Closes the reach to the machine, as a network that goes away does.
///
/// A debug build's own door, and it does nothing in a release. It exists because the failure this
/// app has to answer - a link that ends while no command is asking - cannot be produced on a
/// device by cutting the network of an emulator or a container. What it closes is the reach, not
/// the connection: pie still holds that, its watch reports the end, and a person is offered to
/// dial again with the credential of the connection they already made.
///
/// # Errors
///
/// [`Error::NotConnected`] when there is no connection whose reach could be closed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn close_the_reach(state: State<'_, AppState>) -> Result<(), PieError> {
    // A release has no way to close a reach: the method below does not exist there, so this
    // command cannot do anything even if it is called.
    #[cfg(debug_assertions)]
    {
        let slot = state.sessions.lock().await;
        let Some(connection) = slot.as_ref() else {
            return Err(Error::NotConnected {
                doing: "closing a reach".to_string(),
            }
            .into());
        };
        tracing::info!("a debug build closed the reach to the machine");
        connection.close_the_reach().await;
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        tracing::warn!("a release build was asked to close a reach, and has no way to");
        Ok(())
    }
}

/// How often the watch of a reach asks whether it is still open.
///
/// The question costs nothing, so what sets this is how long a screen may sit there without
/// being told the link is gone: half a second is the point where a person starts to wonder.
/// of a screen that is not being told the link is gone. Nothing is written to the
/// machine to ask.
const WATCH_EVERY: Duration = Duration::from_millis(500);

/// Watches the reach to the machine, and says so when it ends.
///
/// Nothing asks a machine to stay reachable: the network goes away, the host sleeps,
/// the window loses its link. No command need be in flight when that happens, so no
/// command can report it, and a read that fails says it too late and only where it was
/// read. The watch is what carries the end to the frontend, which then offers to bring
/// the reach back.
///
/// The watch belongs to one connection. A `connect` or a `reconnect` replaces the slot,
/// and this task ends with the connection it watched: a task of a connection that is
/// gone announces nothing.
fn watching(app: &AppHandle, connection: SessionManager, id: Id) {
    let app = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            let held = {
                let state = app.state::<AppState>();
                let slot = state.sessions.lock().await;
                slot.as_ref().is_some_and(|current| current.is_same(&connection))
            };
            if !held {
                return;
            }
            if connection.is_open() {
                continue;
            }
            tracing::info!(connection = %id, "the reach to the machine ended");
            if let Err(error) = app.emit(&state_event(&id), ConnectionState::Ended) {
                tracing::warn!(connection = %id, %error, "the end of a reach was not announced");
            }
            return;
        }
    });
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
/// rows carry their full paths, so the picker never builds a path, and the answer
/// names the directory it read: the home of a machine is a directory only the
/// machine can name.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine to read, the failure of the
/// machine if pie cannot read the path, and
/// [`host::Error::NotAbsolute`](crate::host::Error::NotAbsolute) for a relative
/// path (a mistake of the frontend).
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = ?path))]
pub async fn list_dirs(state: State<'_, AppState>, path: Option<String>) -> Result<Listing, PieError> {
    let sessions = state.sessions.lock().await.clone();
    let sessions = sessions.ok_or_else(|| Error::NotConnected {
        doing: "browsing its directories".to_string(),
    })?;
    let path = path.map(HostPath::new);
    Ok(sessions.host().dirs(path.as_ref()).await?)
}

/// Whether a path names a directory on the connected machine.
///
/// The picker asks this when the typed text matches nothing: a name that
/// stands is entered, a name that does not is offered for making.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine, the failure of the machine
/// if the answer cannot be told, and
/// [`host::Error::NotAbsolute`](crate::host::Error::NotAbsolute) for a relative
/// path (a mistake of the frontend).
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = %path))]
pub async fn dir_exists(state: State<'_, AppState>, path: String) -> Result<bool, PieError> {
    let sessions = state.sessions.lock().await.clone();
    let sessions = sessions.ok_or_else(|| Error::NotConnected {
        doing: "reading its directories".to_string(),
    })?;
    Ok(sessions.host().dir_exists(&HostPath::new(path)).await?)
}

/// Makes a directory on the connected machine, with parents as needed.
///
/// The picker offers this when the typed path names nothing: the confirm names
/// the path, and this makes it. `path` is an absolute path on the machine.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine, the failure of the machine
/// if the directory cannot be made, and
/// [`host::Error::NotAbsolute`](crate::host::Error::NotAbsolute) for a relative
/// path (a mistake of the frontend).
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = %path))]
pub async fn create_dir(state: State<'_, AppState>, path: String) -> Result<(), PieError> {
    let sessions = state.sessions.lock().await.clone();
    let sessions = sessions.ok_or_else(|| Error::NotConnected {
        doing: "making a directory".to_string(),
    })?;
    Ok(sessions.host().create(&HostPath::new(path)).await?)
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
