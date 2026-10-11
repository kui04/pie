//! The pipe of one session.
//!
//! Pi writes records to the process that runs one session: the events of the
//! session, the answers to commands, and the dialogs of an extension.
//! `commands::session::attach_session` starts one task of this module for each
//! session, and the task tells the frontend what pi said until the pi of that
//! session ends.
//!
//! The channels are `pi://session/{id}/event` and `.../state`. An event travels
//! as the record pi wrote, re-encoded by the protocol layer's faithful path - a
//! record of a kind this build does not mirror replays verbatim - so a protocol
//! addition reaches the frontend as pi wrote it instead of being dropped. The
//! end travels as [`SessionLifecycle`].
//!
//! An answer to a command never arrives here: the protocol layer hands it to
//! whoever sent it, and only an answer nobody waits for reaches a subscriber.
//! The end of a session arrives on its own channel, and the frontend may not
//! hear it: it reads the id of a session from the answer of `attach_session`, so
//! its listener can only start after that. A read of such a session fails with the
//! protocol layer's own closed error instead, so the frontend still learns the
//! truth from the command that reads.
//!
//! What a listener that does not exist yet costs is silence. Tauri sends an
//! event to a webview only when that webview already listens for the name, and
//! its `emit` answers `Ok(())` when none does (`src/event/listener.rs` and
//! `src/manager/mod.rs` of tauri 2.12.1). Nothing in this module can tell the
//! difference: [`Sink`] for an `AppHandle` sees only a serialization failure or
//! a name that the platform refuses. Therefore the pipe is not the last word on
//! what the frontend hears, and a record that no listener can take is gone
//! without a line in the log.

use std::future::Future;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::channel::Termination;
use crate::session::Session;

use pi_rpc::client::EventStream;
use pi_rpc::error::ErrorKind;
use pi_rpc::event::{Event, encode_event_value};
use pi_rpc::extui::{ConfirmDialog, EditorDialog, InputDialog, Notice, SelectDialog, UiHandler, UiOutcome};

/// What the frontend hears about the life of a session.
///
/// This is the payload of `pi://session/{id}/state`. It is not the
/// `SessionState` of the protocol - that one is the answer of the `get_state`
/// command, and the frontend takes it from the generated types. The channel is
/// named `state` for the same reason as
/// [`ConnectionState`](crate::host::ConnectionState) on the channel of a
/// connection.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionLifecycle {
    /// The pi of this session ended. No record of this session follows.
    ///
    /// The termination separates the end that a person asked for from a pi that
    /// died: a disconnect closes pi's stdin, so its pi exits with success.
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
/// [`AskHostKey`](crate::host::AskHostKey), a seam that the app fills in,
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

/// Sends one event of pi on the channel of its kind.
///
/// The record is re-encoded through the protocol layer's faithful path rather
/// than serialized from the mirrored type: a kind this build does not know
/// replays verbatim, so a newer pi reaches the frontend as it wrote it. A
/// record that will not encode is a line in the log: the frontend must not hear
/// a record that this build cannot describe.
fn spread<S: Sink>(sink: &S, session: &str, event: &Event) {
    match encode_event_value(event) {
        Ok(value) => sink.send(&event_channel(session), value),
        Err(error) => {
            tracing::warn!(%error, session, kind = event.tag(), "an event of pi could not be written down");
        }
    }
}

/// Forwards the records of one session until the pi of that session ends.
///
/// `ended` is the future of the end, which the caller builds from
/// [`Session::handle`](crate::session::Session::handle). It is a parameter so that a
/// test can drive this function with its own stream and its own end.
///
/// # Panics
///
/// Never. A stream that ended before the end could be read leaves this function
/// through the wait for the end, which is the same wait the loop would have
/// made.
pub async fn forward_loop<S: Sink, E: Future<Output = Termination>>(
    sink: S,
    session: &str,
    mut records: EventStream,
    ended: E,
) {
    tokio::pin!(ended);
    let end = loop {
        tokio::select! {
            // The records come first, and `biased` keeps that order. The read
            // loop of the client sets the end *after* it passes its last record
            // on, and the stream drains what is buffered before it reports the
            // end, so every record of pi is on its way here before the end can
            // be read. Without `biased`, the two branches are polled in a random
            // order, and the end that won the race would leave those records
            // behind.
            biased;
            record = records.recv() => match record {
                Ok(event) => spread(&sink, session, &event),
                // This pipe fell behind the records of its session. The frontend
                // reads the state again on its own - the snapshot of the
                // transcript is the authority - so the pipe says what happened
                // and carries on. The stream reports falling behind as a
                // protocol failure and the end as a closed one, and those are
                // the only two it reports.
                Err(error) if error.kind() == ErrorKind::Protocol => {
                    tracing::warn!(%error, session, "a pipe fell behind the records of its session");
                }
                // The stream is over: the records are drained and the end is the
                // only fact left to report.
                Err(_) => break None,
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
/// before this call: the stream carries only what is written after the
/// subscription, so a task that subscribed on its own would have the wider
/// window in which pi writes into no listener at all.
pub fn forward(app: AppHandle, session: &Session, records: EventStream) {
    let id = session.id().to_string();
    let handle = session.handle().clone();
    tauri::async_runtime::spawn(async move {
        forward_loop(app, &id, records, handle.wait()).await;
    });
}

/// Answers the dialogs pi opens on one session.
///
/// Pi blocks on four of them - `select`, `confirm`, `input` and `editor` - until
/// an answer arrives or the dialog times out, and an `editor` dialog has no
/// timeout at all. Until pie has a screen that asks a person, the one answer
/// that keeps pi moving is a dismissal, which is what this handler gives.
///
/// Each dialog arrives with the wire id it was sent under; a future
/// forwarding path can use that id to route an answer back to the dialog
/// it came from. The notices and status lines that need no answer are not
/// forwarded either: no screen reads them yet.
pub async fn answer_dialogs(session: &Session) {
    session
        .client()
        .set_ui_handler(Dialogs {
            session: session.id().to_string(),
        })
        .await;
}

/// The handler that keeps a session moving while pie has no dialogs.
struct Dialogs {
    session: String,
}

#[pi_rpc::async_trait]
impl UiHandler for Dialogs {
    async fn select(&mut self, id: String, dialog: SelectDialog) -> UiOutcome {
        self.dismissed("select", &id, &dialog.title);
        UiOutcome::Dismissed
    }

    async fn confirm(&mut self, id: String, dialog: ConfirmDialog) -> bool {
        self.dismissed("confirm", &id, &dialog.title);
        false
    }

    async fn input(&mut self, id: String, dialog: InputDialog) -> UiOutcome {
        self.dismissed("input", &id, &dialog.title);
        UiOutcome::Dismissed
    }

    async fn editor(&mut self, id: String, dialog: EditorDialog) -> UiOutcome {
        self.dismissed("editor", &id, &dialog.title);
        UiOutcome::Dismissed
    }

    async fn notify(&mut self, notice: Notice) {
        tracing::debug!(session = %self.session, message = %notice.message, "pi showed a notice");
    }

    async fn set_title(&mut self, title: pi_rpc::extui::WindowTitle) {
        tracing::debug!(session = %self.session, title = %title.title, "pi set the window title");
    }
}

impl Dialogs {
    /// Says which dialog was dropped, and why.
    fn dismissed(&self, method: &str, id: &str, title: &str) {
        tracing::warn!(
            session = %self.session,
            dialog = method,
            id,
            title,
            "a dialog of pi was dismissed: pie has no screen that answers one yet",
        );
    }
}
