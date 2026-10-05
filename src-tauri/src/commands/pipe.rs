//! The pipe of one session.
//!
//! Pi writes four kinds of record to the process that runs one session: the
//! events of the session, the dialogs of an extension, the failures of an
//! extension, and the answers to commands. `connect` starts one task of this
//! module for each session, and the task tells the frontend what pi said until
//! the pi of that session ends.
//!
//! The channels are `pi://session/{id}/event`, `.../state`, `.../prompt` and
//! `.../error`. An event travels as itself, and the end travels as
//! [`SessionLifecycle`]. Only the event channel is consumed today: the dialogs
//! and the failures of an extension arrive on their channels and wait for the
//! milestone that answers and reports them.
//!
//! An event travels as the mirror type, not as the line pi wrote: a field that
//! this pin does not know is not in the type, and serde drops what it does not
//! know, so such a field does not reach the frontend. The connect refuses a pi of
//! another release (`pi_rpc::check_version`), which bounds that to a pi that
//! reports this release and writes something else.
//!
//! Three kinds of record are not forwarded. A `Response` arrives here only when
//! nobody waits for it, because the client hands an answer to its waiter and
//! broadcasts the rest. `Unknown` and `Unparseable` say that pi moved ahead of
//! this mirror. All three are a line in the log and nothing else: the frontend
//! must not hear a record that this build cannot describe.
//!
//! The end of a session arrives on its own channel, and the frontend may not
//! hear it: it reads the id of a session from the answer of `connect`, so its
//! listener can only start after that. A read of such a session fails with
//! `pi_rpc::Error::Closed` instead, so the frontend still learns the truth from
//! the command that reads.
//!
//! What a listener that does not exist yet costs is silence. Tauri sends an
//! event to a webview only when that webview already listens for the name, and
//! its `emit` answers `Ok(())` when none does (`src/event/listener.rs` and
//! `src/manager/mod.rs` of tauri 2.12.1). Nothing in this module can tell the
//! difference: [`Sink`] for an `AppHandle` sees only a serialization failure or a
//! name that the platform refuses. Therefore the pipe is not the last word on
//! what the frontend hears, and a record that no listener can take is gone
//! without a line in the log.
//!
//! A dialog of an extension is the loss that hurts: pi waits for an answer until
//! a response, an abort, or the timeout of the request, and only `select`,
//! `confirm` and `input` may carry a timeout - the `editor` shape has no such
//! field at all. A dialog without one that never reaches pie waits forever. The
//! milestone that answers dialogs must therefore start from a channel the
//! frontend can take before it knows the id, or from a record that Rust keeps
//! for it. Neither exists yet.

use std::future::Future;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

use crate::connection::Session;
use crate::pi_rpc::protocol::ServerMessage;
use crate::pi_rpc::transport::Termination;

/// What the frontend hears about the life of a session.
///
/// This is the payload of `pi://session/{id}/state`. It is not the
/// `SessionState` of the protocol - that one is the answer of the `get_state`
/// command, and the frontend takes it from the generated types. The channel is
/// named `state` for the same reason as
/// [`ConnectionState`](crate::connection::ConnectionState) on the channel of a
/// connection.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionLifecycle {
    /// The pi of this session ended. No record of this session follows.
    ///
    /// The termination separates the end that a person asked for from a pi that
    /// died: `disconnect` closes pi's stdin, so its pi exits with success.
    Ended {
        /// How the process ended.
        termination: Termination,
    },
}

/// Where a pipe delivers what it forwards.
///
/// The app itself is one of these: it hands the payload to the frontend. A test
/// is another, so that the order of the records and of the end can be held
/// without a window: the shape follows
/// [`AskHostKey`](crate::connection::AskHostKey), a seam that the app fills in,
/// and a test fills in differently.
pub trait Sink {
    /// Delivers one payload on one channel.
    fn send<S: Serialize + Clone>(&self, channel: &str, payload: S);
}

impl Sink for AppHandle {
    fn send<S: Serialize + Clone>(&self, channel: &str, payload: S) {
        if let Err(error) = self.emit(channel, payload) {
            // The name of the channel is one no listener can take, or the
            // payload does not serialize. Either way this record is lost, and
            // the log is the only place left to say so.
            //
            // A missing listener is not here: `emit` answers `Ok(())` for an
            // event that no webview listens for, and no API of this app says
            // whether one does.
            tracing::warn!(%error, channel, "the frontend did not hear a record of a session");
        }
    }
}

/// The channel that carries one event of a session.
fn event_channel(session: &str) -> String {
    format!("pi://session/{session}/event")
}

/// The channel that carries the end of a session.
fn state_channel(session: &str) -> String {
    format!("pi://session/{session}/state")
}

/// The channel that carries a dialog of an extension.
fn prompt_channel(session: &str) -> String {
    format!("pi://session/{session}/prompt")
}

/// The channel that carries a failure of an extension.
fn error_channel(session: &str) -> String {
    format!("pi://session/{session}/error")
}

/// Sends one record of pi on the channel of its kind.
///
/// A record that this pipe does not forward is dropped here, with the line in
/// the log that says which kind it was. There is no routing value in between:
/// the payloads of pi are large (an `Event` is over half a kilobyte), and a
/// value that carried one would copy it.
fn spread<S: Sink>(sink: &S, session: &str, record: ServerMessage) {
    match record {
        ServerMessage::Event(event) => sink.send(&event_channel(session), event),
        ServerMessage::ExtensionUiRequest(request) => sink.send(&prompt_channel(session), request),
        ServerMessage::ExtensionError(error) => sink.send(&error_channel(session), error),
        // Nobody waits for this answer: the client gives a response to its
        // waiter, and only an answer with no waiter reaches a subscriber.
        ServerMessage::Response(response) => {
            tracing::debug!(id = ?response.id, command = %response.command, "a response with no waiter is not forwarded");
        }
        ServerMessage::Unknown { raw } => {
            tracing::debug!(record = %raw, "a record this mirror does not know is not forwarded");
        }
        ServerMessage::Unparseable { line, error } => {
            tracing::warn!(%error, line = %line, "a line pi wrote is not JSON");
        }
    }
}

/// Forwards the records of one session until the pi of that session ends.
///
/// `ended` is the future of the end, which the caller builds from
/// [`Client::wait`](crate::pi_rpc::Client::wait). It is a parameter so that a
/// test can drive this function with its own channel and its own end.
///
/// # Panics
///
/// Never. A channel that closed before the end could be read leaves this
/// function through the wait for the end, which is the same wait the loop would
/// have made.
pub async fn forward_loop<S: Sink, E: Future<Output = Termination>>(
    sink: S,
    session: &str,
    mut records: broadcast::Receiver<ServerMessage>,
    ended: E,
) {
    tokio::pin!(ended);
    let end = loop {
        tokio::select! {
            // The records come first, and `biased` keeps that order. The read
            // loop of the client sets the end *after* it passes its last record
            // on, so every record of pi is in this channel before the end can be
            // read. Without `biased`, the two branches are polled in a random
            // order, and the end that won the race would leave those records
            // behind in the channel.
            biased;
            record = records.recv() => match record {
                Ok(record) => spread(&sink, session, record),
                // This pipe fell behind the records of its session. The frontend
                // reads the state again on its own - the snapshot of the
                // transcript is the authority - so the pipe says what happened
                // and carries on.
                Err(broadcast::error::RecvError::Lagged(behind)) => {
                    tracing::warn!(behind, session, "a pipe fell behind the records of its session");
                }
                // Unreachable while the caller holds a client: the sender of this
                // channel lives beside the client, in the same `Inner`. If it
                // ever happens, the records are gone and the end is the only
                // fact left to report.
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::debug!(session, "the channel of a session closed before its end");
                    break None;
                }
            },
            termination = &mut ended => break Some(termination),
        }
    };

    let termination = match end {
        Some(termination) => termination,
        None => ended.await,
    };
    sink.send(&state_channel(session), SessionLifecycle::Ended { termination });
}

/// Starts the pipe of one session.
///
/// `records` must come from the client of `session`, and the caller subscribes
/// before this call: a broadcast channel delivers only to the receivers that are
/// already there, so a task that subscribed on its own would have the wider
/// window in which pi writes into no receiver at all.
pub fn forward(app: AppHandle, session: &Session, records: broadcast::Receiver<ServerMessage>) {
    let id = session.id().to_string();
    let client = session.client().clone();
    tauri::async_runtime::spawn(async move {
        forward_loop(app, &id, records, client.wait()).await;
    });
}
