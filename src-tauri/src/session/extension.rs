//! The extension UI subprotocol of one session.
//!
//! Pi sends `extension_ui_request` records while an extension asks for a person:
//! four kinds block the extension until pie answers, and five are notices that
//! need no answer. The protocol layer hands the request to the handler installed
//! on the client; this module holds what the frontend has not answered yet.
//!
//! The pending dialogs live here, not in the Tauri layer. A request can arrive
//! before the frontend knows the id of the session, so an event is not enough:
//! the snapshot is what a new listener reads, and the event only lowers the
//! latency of the next read. A dialog that pi timed out is removed with its
//! handler future, so a late answer cannot resolve a request that is gone.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use pi_rpc::client::Client;
use pi_rpc::extui::{
    self, ConfirmDialog, EditorDialog, EditorText, InputDialog, Notice, SelectDialog, StatusEntry, UiAnswer, UiHandler,
    UiOutcome, UiRequest, WindowTitle,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};

/// How many extension events a listener may fall behind before it is told to
/// read the snapshot again.
const EVENT_CAPACITY: usize = 64;

/// One pending dialog, as the frontend reads it.
///
/// The fields after `id` are the exact wire fields of pi's
/// `RpcExtensionUIRequest`; `type` is the record tag pi writes but the protocol
/// layer strips before handing the body to [`UiHandler`].
#[derive(Debug, Clone, Serialize)]
pub struct ExtensionRequest {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    #[serde(flatten)]
    body: UiRequest,
}

/// A status line of one extension.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    /// The key pi uses for this status line.
    pub key: String,
    /// The words pi asked pie to show.
    pub text: String,
}

/// The latest editor text that pi asked pie to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTextUpdate {
    /// The order of this update; a reader applies each sequence once.
    pub seq: u64,
    /// The text pi put in the editor.
    pub text: String,
}

/// What the frontend reads after attaching to a session.
///
/// It is the replay of everything a listener that was not there yet could have
/// missed. Dialog requests are removed when they are answered or timed out; the
/// fire-and-forget values stay until pi changes or clears them.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionState {
    /// Dialogs that wait for an answer.
    pub requests: Vec<ExtensionRequest>,
    /// The latest status line of each extension key.
    pub statuses: Vec<ExtensionStatus>,
    /// The title an extension asked for.
    pub title: Option<String>,
    /// The latest editor text, with its sequence.
    pub editor_text: Option<EditorTextUpdate>,
}

/// One event for the frontend. `Changed` makes it read the snapshot again; a
/// notice also becomes a toast.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionEvent {
    /// The snapshot changed; read it again.
    Changed,
    /// Show a notice; the snapshot does not carry notices.
    Notice {
        /// The id of this notice, unique for this session.
        id: String,
        /// The words of the notice.
        message: String,
        /// `info`, `warning`, `error`, or a future kind.
        #[serde(rename = "notifyType")]
        notify_type: String,
    },
}

/// An answer to one dialog, from the IPC boundary.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionAnswer {
    /// A text answer for select, input, or editor.
    Value { value: String },
    /// A boolean answer for confirm.
    Confirmed { confirmed: bool },
    /// The person dismissed the dialog.
    Cancelled,
}

impl From<ExtensionAnswer> for UiAnswer {
    fn from(answer: ExtensionAnswer) -> Self {
        match answer {
            ExtensionAnswer::Value { value } => UiAnswer::Value(value),
            ExtensionAnswer::Confirmed { confirmed } => UiAnswer::Confirmed(confirmed),
            ExtensionAnswer::Cancelled => UiAnswer::Cancelled,
        }
    }
}

/// A question of pi that has not been answered.
struct Pending {
    id: String,
    request: UiRequest,
    answer: oneshot::Sender<UiAnswer>,
}

/// The state of the extension UI of one session.
#[derive(Clone, Default)]
pub(crate) struct Extension {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Extension {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Extension")
            .field(
                "pending",
                &self.inner.pending.lock().map(|pending| pending.len()).unwrap_or(0),
            )
            .finish_non_exhaustive()
    }
}

struct Inner {
    pending: Mutex<Vec<Pending>>,
    state: Mutex<ExtensionInnerState>,
    events: broadcast::Sender<ExtensionEvent>,
    next_id: AtomicU64,
}

impl Default for Inner {
    fn default() -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            pending: Mutex::new(Vec::new()),
            state: Mutex::new(ExtensionInnerState::default()),
            events,
            next_id: AtomicU64::new(0),
        }
    }
}

/// The values a fire-and-forget request can change.
#[derive(Default)]
struct ExtensionInnerState {
    statuses: BTreeMap<String, String>,
    title: Option<String>,
    editor_text: Option<EditorTextUpdate>,
}

impl Extension {
    /// Installs this handler on the client of one session.
    ///
    /// It is installed before the session reaches the frontend, so the snapshot
    /// holds every request from that moment on. The client's read loop starts with
    /// the client, and a request that arrives before this call has no handler to
    /// ask: the client answers it as cancelled. Closing that window needs a handler
    /// at the client's construction, which the protocol crate does not offer.
    pub(crate) async fn install(&self, client: &Client) {
        client.set_ui_handler(self.clone()).await;
    }

    /// The current replayable state, for a listener that just arrived.
    pub(crate) fn snapshot(&self) -> ExtensionState {
        let state = self.inner.state.lock().unwrap_or_else(PoisonError::into_inner);
        let pending = self.inner.pending.lock().unwrap_or_else(PoisonError::into_inner);
        ExtensionState {
            requests: pending
                .iter()
                .map(|pending| ExtensionRequest {
                    kind: "extension_ui_request",
                    id: pending.id.clone(),
                    body: pending.request.clone(),
                })
                .collect(),
            statuses: state
                .statuses
                .iter()
                .map(|(key, text)| ExtensionStatus {
                    key: key.clone(),
                    text: text.clone(),
                })
                .collect(),
            title: state.title.clone(),
            editor_text: state.editor_text.clone(),
        }
    }

    /// Answers one pending dialog. `false` means no request waited under that id.
    pub(crate) fn answer(&self, id: &str, answer: UiAnswer) -> bool {
        let pending = {
            let mut pending = self.inner.pending.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(index) = pending.iter().position(|question| question.id == id) else {
                return false;
            };
            pending.remove(index)
        };
        let answered = pending.answer.send(answer).is_ok();
        self.changed();
        answered
    }

    /// The stream of changes for the frontend listener.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ExtensionEvent> {
        self.inner.events.subscribe()
    }

    async fn ask(&self, id: String, request: UiRequest) -> UiAnswer {
        let (answer, received) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Pending {
                id: id.clone(),
                request,
                answer,
            });
        let mut guard = PendingGuard {
            extension: self.clone(),
            id,
            armed: true,
        };
        self.changed();
        let answer = received.await.unwrap_or(UiAnswer::Cancelled);
        guard.armed = false;
        answer
    }

    fn changed(&self) {
        let _ = self.inner.events.send(ExtensionEvent::Changed);
    }

    fn next_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn show_notice(&self, notice: Notice) {
        let notify_type = match notice.notify_type {
            Some(extui::NoticeKind::Info) | None => "info",
            Some(extui::NoticeKind::Warning) => "warning",
            Some(extui::NoticeKind::Error) => "error",
            Some(extui::NoticeKind::Other(kind)) => {
                let _ = self.inner.events.send(ExtensionEvent::Notice {
                    id: format!("{}", self.next_id()),
                    message: notice.message,
                    notify_type: kind,
                });
                return;
            }
        };
        let _ = self.inner.events.send(ExtensionEvent::Notice {
            id: format!("{}", self.next_id()),
            message: notice.message,
            notify_type: notify_type.to_string(),
        });
    }

    fn remember_status(&self, entry: StatusEntry) {
        {
            let mut state = self.inner.state.lock().unwrap_or_else(PoisonError::into_inner);
            match entry.status_text {
                Some(text) => {
                    state.statuses.insert(entry.status_key, text);
                }
                None => {
                    state.statuses.remove(&entry.status_key);
                }
            }
        }
        self.changed();
    }

    fn remember_title(&self, title: WindowTitle) {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner).title = Some(title.title);
        self.changed();
    }

    fn remember_editor_text(&self, text: EditorText) {
        let seq = self.next_id();
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .editor_text = Some(EditorTextUpdate { seq, text: text.text });
        self.changed();
    }
}

/// Removes a request that pi timed out while its handler future was dropped.
struct PendingGuard {
    extension: Extension,
    id: String,
    armed: bool,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if self.armed {
            self.extension
                .inner
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|question| question.id != self.id);
            self.extension.changed();
        }
    }
}

#[pi_rpc::async_trait]
impl UiHandler for Extension {
    async fn select(&mut self, id: String, dialog: SelectDialog) -> UiOutcome {
        match self.ask(id, UiRequest::Select(dialog)).await {
            UiAnswer::Value(value) => UiOutcome::Value(value),
            UiAnswer::Confirmed(_) | UiAnswer::Cancelled => UiOutcome::Dismissed,
        }
    }

    async fn confirm(&mut self, id: String, dialog: ConfirmDialog) -> bool {
        match self.ask(id, UiRequest::Confirm(dialog)).await {
            UiAnswer::Confirmed(confirmed) => confirmed,
            UiAnswer::Value(_) | UiAnswer::Cancelled => false,
        }
    }

    async fn input(&mut self, id: String, dialog: InputDialog) -> UiOutcome {
        match self.ask(id, UiRequest::Input(dialog)).await {
            UiAnswer::Value(value) => UiOutcome::Value(value),
            UiAnswer::Confirmed(_) | UiAnswer::Cancelled => UiOutcome::Dismissed,
        }
    }

    async fn editor(&mut self, id: String, dialog: EditorDialog) -> UiOutcome {
        match self.ask(id, UiRequest::Editor(dialog)).await {
            UiAnswer::Value(value) => UiOutcome::Value(value),
            UiAnswer::Confirmed(_) | UiAnswer::Cancelled => UiOutcome::Dismissed,
        }
    }

    async fn notify(&mut self, notice: Notice) {
        self.show_notice(notice);
    }

    async fn set_status(&mut self, entry: StatusEntry) {
        self.remember_status(entry);
    }

    async fn set_title(&mut self, title: WindowTitle) {
        self.remember_title(title);
    }

    async fn set_editor_text(&mut self, text: EditorText) {
        self.remember_editor_text(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select() -> UiRequest {
        UiRequest::Select(SelectDialog {
            title: "Allow?".to_string(),
            options: vec!["Allow".to_string(), "Block".to_string()],
            timeout: None,
        })
    }

    async fn wait_for_request(extension: &Extension) -> ExtensionState {
        for _ in 0..100 {
            let state = extension.snapshot();
            if !state.requests.is_empty() {
                return state;
            }
            tokio::task::yield_now().await;
        }
        panic!("the dialog did not reach the snapshot");
    }

    #[tokio::test]
    async fn a_dialog_waits_for_its_answer_and_the_snapshot_replays_it() {
        let extension = Extension::default();
        let asking = extension.clone();
        let task = tokio::spawn(async move { asking.ask("q-1".to_string(), select()).await });

        let state = wait_for_request(&extension).await;
        let request = serde_json::to_value(&state.requests[0]).expect("a request serializes");
        assert_eq!(request["type"], "extension_ui_request");
        assert_eq!(request["id"], "q-1");
        assert_eq!(request["method"], "select");
        assert_eq!(request["title"], "Allow?");
        assert_eq!(request["options"], serde_json::json!(["Allow", "Block"]));

        assert!(extension.answer("q-1", UiAnswer::Value("Allow".to_string())));
        assert_eq!(
            task.await.expect("the asker finishes"),
            UiAnswer::Value("Allow".to_string())
        );
        assert!(
            extension.snapshot().requests.is_empty(),
            "an answered dialog leaves the queue"
        );
    }

    #[tokio::test]
    async fn a_dialog_removed_by_its_cancelled_future_cannot_be_answered() {
        let extension = Extension::default();
        let asking = extension.clone();
        let task = tokio::spawn(async move { asking.ask("q-2".to_string(), select()).await });

        wait_for_request(&extension).await;
        task.abort();
        let _ = task.await;
        assert!(!extension.answer("q-2", UiAnswer::Value("Allow".to_string())));
        assert!(
            extension.snapshot().requests.is_empty(),
            "a timed out dialog is not replayable"
        );
    }

    #[tokio::test]
    async fn values_without_an_answer_stay_in_the_snapshot_and_a_notice_is_an_event() {
        let extension = Extension::default();
        let mut events = extension.subscribe();
        let mut ui = extension.clone();
        UiHandler::set_status(
            &mut ui,
            StatusEntry {
                status_key: "ext".to_string(),
                status_text: Some("working".to_string()),
            },
        )
        .await;
        UiHandler::set_title(
            &mut ui,
            WindowTitle {
                title: "pi".to_string(),
            },
        )
        .await;
        UiHandler::notify(
            &mut ui,
            Notice {
                message: "done".to_string(),
                notify_type: Some(extui::NoticeKind::Warning),
            },
        )
        .await;

        let state = extension.snapshot();
        assert_eq!(state.statuses[0].key, "ext");
        assert_eq!(state.title.as_deref(), Some("pi"));

        let event = loop {
            match events.recv().await.expect("the channel stays open") {
                ExtensionEvent::Notice { message, .. } => break message,
                ExtensionEvent::Changed => {}
            }
        };
        assert_eq!(event, "done");
    }

    #[tokio::test]
    async fn requests_keep_their_arrival_order() {
        let extension = Extension::default();
        let first = extension.clone();
        let second = extension.clone();
        let one = tokio::spawn(async move { first.ask("q-1".to_string(), select()).await });
        wait_for_request(&extension).await;
        let two = tokio::spawn(async move { second.ask("q-2".to_string(), select()).await });
        for _ in 0..100 {
            if extension.snapshot().requests.len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }

        let state = extension.snapshot();
        assert_eq!(
            state
                .requests
                .iter()
                .map(|request| request.id.as_str())
                .collect::<Vec<_>>(),
            ["q-1", "q-2"]
        );
        assert!(extension.answer("q-1", UiAnswer::Cancelled));
        one.await.expect("the first asker finishes");
        assert_eq!(
            extension
                .snapshot()
                .requests
                .iter()
                .map(|request| request.id.as_str())
                .collect::<Vec<_>>(),
            ["q-2"]
        );
        assert!(extension.answer("q-2", UiAnswer::Cancelled));
        two.await.expect("the second asker finishes");
    }
}
