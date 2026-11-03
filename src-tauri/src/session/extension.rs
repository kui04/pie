//! The extension dialogs and notices of one session.

use std::time::Duration;

use pi_rpc::extui::{
    ConfirmDialog, EditorDialog, EditorText, InputDialog, Notice, NoticeKind, SelectDialog,
    StatusEntry, UiAnswer, UiHandler, UiOutcome, UiRequest, WindowTitle,
};
use serde::{Deserialize, Serialize};
use typed_path::Utf8TypedPathBuf;

use crate::bus::{Ask, Bus, Notification};
use crate::host::HostId;

/// One extension dialog that waits for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ExtensionAsk {
    pub host: HostId,
    pub session: Utf8TypedPathBuf,
    pub request: UiRequest,
}

/// The frontend's answer to one extension dialog.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionAnswer {
    Value { value: String },
    Confirmed { confirmed: bool },
    Cancelled,
}

impl Ask for ExtensionAsk {
    type Answer = ExtensionAnswer;
    const EVENT_NAME: &'static str = "pi://ask/extension";
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

/// One notice that pi wants the frontend to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionNotice {
    pub host: HostId,
    pub session: Utf8TypedPathBuf,
    pub message: String,
    /// `info`, `warning`, `error`, or a name this pie does not know yet.
    pub kind: String,
}

impl Notification for ExtensionNotice {
    const EVENT_NAME: &'static str = "pi://extension/notice";
}

/// One status entry of the extension area.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    pub host: HostId,
    pub session: Utf8TypedPathBuf,
    pub key: String,
    pub text: Option<String>,
}

impl Notification for ExtensionStatus {
    const EVENT_NAME: &'static str = "pi://extension/status";
}

/// The window title that pi asks for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionTitle {
    pub host: HostId,
    pub session: Utf8TypedPathBuf,
    pub title: String,
}

impl Notification for ExtensionTitle {
    const EVENT_NAME: &'static str = "pi://extension/title";
}

/// The editor text that pi asks for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionEditorText {
    pub host: HostId,
    pub session: Utf8TypedPathBuf,
    pub text: String,
}

impl Notification for ExtensionEditorText {
    const EVENT_NAME: &'static str = "pi://extension/editor";
}

/// How long a dialog waits when pi sets no timeout.
const EXTENSION_PATIENCE: Duration = Duration::from_secs(5 * 60);

/// The dialog handler of one session. It forwards each dialog and notice.
pub(crate) struct Extension {
    bus: Bus,
    host: HostId,
    session: Utf8TypedPathBuf,
}

impl Extension {
    pub(crate) fn new(bus: Bus, host: HostId, session: Utf8TypedPathBuf) -> Self {
        Self { bus, host, session }
    }

    async fn ask(&self, request: UiRequest, timeout: Duration) -> Option<ExtensionAnswer> {
        let ask = ExtensionAsk {
            host: self.host.clone(),
            session: self.session.clone(),
            request,
        };
        self.bus.ask::<ExtensionAsk>(ask, timeout).await.ok()
    }

    fn tell<N: Notification>(&self, notification: N) {
        if let Err(error) = self.bus.notify(notification) {
            tracing::warn!(%error, "an extension notification did not leave");
        }
    }
}

fn patience(timeout: Option<f64>) -> Duration {
    timeout
        .filter(|millis| *millis > 0.0)
        .map(|millis| Duration::from_millis(millis as u64))
        .unwrap_or(EXTENSION_PATIENCE)
}

fn notice_kind(kind: Option<NoticeKind>) -> String {
    match kind.unwrap_or(NoticeKind::Info) {
        NoticeKind::Info => "info".to_string(),
        NoticeKind::Warning => "warning".to_string(),
        NoticeKind::Error => "error".to_string(),
        NoticeKind::Other(name) => name,
    }
}

#[pi_rpc::async_trait]
impl UiHandler for Extension {
    async fn select(&mut self, _id: String, dialog: SelectDialog) -> UiOutcome {
        let timeout = patience(dialog.timeout);
        match self.ask(UiRequest::Select(dialog), timeout).await {
            Some(ExtensionAnswer::Value { value }) => UiOutcome::Value(value),
            _ => UiOutcome::Dismissed,
        }
    }

    async fn confirm(&mut self, _id: String, dialog: ConfirmDialog) -> bool {
        let timeout = patience(dialog.timeout);
        matches!(
            self.ask(UiRequest::Confirm(dialog), timeout).await,
            Some(ExtensionAnswer::Confirmed { confirmed: true })
        )
    }

    async fn input(&mut self, _id: String, dialog: InputDialog) -> UiOutcome {
        let timeout = patience(dialog.timeout);
        match self.ask(UiRequest::Input(dialog), timeout).await {
            Some(ExtensionAnswer::Value { value }) => UiOutcome::Value(value),
            _ => UiOutcome::Dismissed,
        }
    }

    async fn editor(&mut self, _id: String, dialog: EditorDialog) -> UiOutcome {
        match self
            .ask(UiRequest::Editor(dialog), EXTENSION_PATIENCE)
            .await
        {
            Some(ExtensionAnswer::Value { value }) => UiOutcome::Value(value),
            _ => UiOutcome::Dismissed,
        }
    }

    async fn notify(&mut self, notice: Notice) {
        self.tell(ExtensionNotice {
            host: self.host.clone(),
            session: self.session.clone(),
            message: notice.message,
            kind: notice_kind(notice.notify_type),
        });
    }

    async fn set_status(&mut self, entry: StatusEntry) {
        self.tell(ExtensionStatus {
            host: self.host.clone(),
            session: self.session.clone(),
            key: entry.status_key,
            text: entry.status_text,
        });
    }

    async fn set_title(&mut self, title: WindowTitle) {
        self.tell(ExtensionTitle {
            host: self.host.clone(),
            session: self.session.clone(),
            title: title.title,
        });
    }

    async fn set_editor_text(&mut self, text: EditorText) {
        self.tell(ExtensionEditorText {
            host: self.host.clone(),
            session: self.session.clone(),
            text: text.text,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::*;
    use crate::bus::{Answer, AskId};

    /// How long a test waits for an event before it calls the bus stuck.
    const PATIENCE: Duration = Duration::from_secs(2);

    fn file() -> Utf8TypedPathBuf {
        Utf8TypedPathBuf::from_unix("/home/u/.pi/agent/sessions/a.jsonl")
    }

    fn frontend() -> (Bus, mpsc::UnboundedReceiver<(String, Value)>) {
        let (bus, events) = Bus::recording(8);
        bus.ready();
        (bus, events)
    }

    async fn next(events: &mut mpsc::UnboundedReceiver<(String, Value)>) -> (String, Value) {
        tokio::time::timeout(PATIENCE, events.recv())
            .await
            .expect("the event arrives in time")
            .expect("the event channel stays open")
    }

    async fn next_ask(events: &mut mpsc::UnboundedReceiver<(String, Value)>) -> (AskId, Value) {
        let (event, payload) = next(events).await;
        assert_eq!(event, ExtensionAsk::EVENT_NAME);

        let id = serde_json::from_value(payload["id"].clone()).expect("an ask id");
        (id, payload["payload"].clone())
    }

    #[test]
    fn a_dialog_waits_as_long_as_pi_asks_and_five_minutes_when_it_does_not() {
        assert_eq!(patience(None), EXTENSION_PATIENCE);
        assert_eq!(patience(Some(1_500.0)), Duration::from_millis(1_500));
        assert_eq!(patience(Some(0.0)), EXTENSION_PATIENCE);
        assert_eq!(patience(Some(-1.0)), EXTENSION_PATIENCE);
    }

    #[test]
    fn a_fractional_timeout_is_whole_milliseconds() {
        assert_eq!(patience(Some(1_500.9)), Duration::from_millis(1_500));
    }

    #[test]
    fn a_notice_keeps_the_severity_pi_sent_and_passes_an_unknown_one_through() {
        assert_eq!(notice_kind(None), "info");
        assert_eq!(notice_kind(Some(NoticeKind::Info)), "info");
        assert_eq!(notice_kind(Some(NoticeKind::Warning)), "warning");
        assert_eq!(notice_kind(Some(NoticeKind::Error)), "error");
        assert_eq!(
            notice_kind(Some(NoticeKind::Other("critical".to_owned()))),
            "critical"
        );
    }

    #[test]
    fn each_frontend_answer_becomes_the_answer_pi_waits_for() {
        assert_eq!(
            UiAnswer::from(ExtensionAnswer::Value {
                value: "x".to_owned()
            }),
            UiAnswer::Value("x".to_owned())
        );
        assert_eq!(
            UiAnswer::from(ExtensionAnswer::Confirmed { confirmed: true }),
            UiAnswer::Confirmed(true)
        );
        assert_eq!(
            UiAnswer::from(ExtensionAnswer::Confirmed { confirmed: false }),
            UiAnswer::Confirmed(false)
        );
        assert_eq!(
            UiAnswer::from(ExtensionAnswer::Cancelled),
            UiAnswer::Cancelled
        );
    }

    #[test]
    fn an_extension_answer_is_tagged_on_the_wire() {
        let value: ExtensionAnswer =
            serde_json::from_value(json!({ "type": "value", "value": "two" })).expect("an answer");
        assert!(matches!(value, ExtensionAnswer::Value { ref value } if value == "two"));

        let confirmed: ExtensionAnswer =
            serde_json::from_value(json!({ "type": "confirmed", "confirmed": true }))
                .expect("an answer");
        assert!(matches!(
            confirmed,
            ExtensionAnswer::Confirmed { confirmed: true }
        ));

        let cancelled: ExtensionAnswer =
            serde_json::from_value(json!({ "type": "cancelled" })).expect("an answer");
        assert!(matches!(cancelled, ExtensionAnswer::Cancelled));

        assert!(serde_json::from_value::<ExtensionAnswer>(json!({ "type": "other" })).is_err());
        assert!(serde_json::from_value::<ExtensionAnswer>(json!({ "type": "value" })).is_err());
    }

    #[test]
    fn an_extension_ask_carries_the_host_the_file_and_the_request() {
        let ask = ExtensionAsk {
            host: HostId::new("laptop"),
            session: file(),
            request: UiRequest::Select(SelectDialog {
                title: "Pick one".to_owned(),
                options: vec!["one".to_owned(), "two".to_owned()],
                timeout: Some(1_500.0),
            }),
        };

        let wire = serde_json::to_value(&ask).expect("an ask serializes");

        assert_eq!(wire["host"], "laptop");
        assert_eq!(wire["session"], "/home/u/.pi/agent/sessions/a.jsonl");
        assert_eq!(wire["request"]["method"], "select");
        assert_eq!(wire["request"]["title"], "Pick one");
        assert_eq!(wire["request"]["options"], json!(["one", "two"]));
    }

    #[test]
    fn the_extension_events_keep_their_names() {
        assert_eq!(ExtensionAsk::EVENT_NAME, "pi://ask/extension");
        assert_eq!(ExtensionNotice::EVENT_NAME, "pi://extension/notice");
        assert_eq!(ExtensionStatus::EVENT_NAME, "pi://extension/status");
        assert_eq!(ExtensionTitle::EVENT_NAME, "pi://extension/title");
        assert_eq!(ExtensionEditorText::EVENT_NAME, "pi://extension/editor");
    }

    #[tokio::test]
    async fn a_selected_value_reaches_pi() {
        let (bus, mut events) = frontend();

        let asking = tokio::spawn({
            let mut extension = Extension::new(bus.clone(), HostId::new("laptop"), file());
            async move {
                extension
                    .select(
                        "ask".to_owned(),
                        SelectDialog {
                            title: "Pick one".to_owned(),
                            options: vec!["one".to_owned(), "two".to_owned()],
                            timeout: Some(2_000.0),
                        },
                    )
                    .await
            }
        });

        let (id, payload) = next_ask(&mut events).await;
        assert_eq!(payload["request"]["method"], "select");
        assert!(bus.answer(
            id,
            Answer::Resolved(json!({ "type": "value", "value": "two" }))
        ));

        assert_eq!(
            asking.await.expect("the ask task lives"),
            UiOutcome::Value("two".to_owned())
        );
    }

    #[tokio::test]
    async fn a_cancelled_select_is_dismissed() {
        let (bus, mut events) = frontend();

        let asking = tokio::spawn({
            let mut extension = Extension::new(bus.clone(), HostId::new("laptop"), file());
            async move {
                extension
                    .select(
                        "ask".to_owned(),
                        SelectDialog {
                            title: "Pick one".to_owned(),
                            options: vec!["one".to_owned()],
                            timeout: Some(2_000.0),
                        },
                    )
                    .await
            }
        });

        let (id, _) = next_ask(&mut events).await;
        assert!(bus.answer(id, Answer::Resolved(json!({ "type": "cancelled" }))));

        assert_eq!(
            asking.await.expect("the ask task lives"),
            UiOutcome::Dismissed
        );
    }

    #[tokio::test]
    async fn a_confirm_is_true_only_when_the_person_confirms() {
        let (bus, mut events) = frontend();

        for (confirmed, expected) in [(true, true), (false, false)] {
            let asking = tokio::spawn({
                let mut extension = Extension::new(bus.clone(), HostId::new("laptop"), file());
                async move {
                    extension
                        .confirm(
                            "ask".to_owned(),
                            ConfirmDialog {
                                title: "Run it?".to_owned(),
                                message: "the command".to_owned(),
                                timeout: Some(2_000.0),
                            },
                        )
                        .await
                }
            });

            let (id, _) = next_ask(&mut events).await;
            assert!(bus.answer(
                id,
                Answer::Resolved(json!({ "type": "confirmed", "confirmed": confirmed }))
            ));

            assert_eq!(asking.await.expect("the ask task lives"), expected);
        }
    }

    #[tokio::test]
    async fn an_unanswered_input_dismisses_itself_when_its_timeout_ends() {
        let (bus, mut events) = frontend();
        let mut extension = Extension::new(bus.clone(), HostId::new("laptop"), file());

        let outcome = extension
            .input(
                "ask".to_owned(),
                InputDialog {
                    title: "Name".to_owned(),
                    placeholder: None,
                    timeout: Some(50.0),
                },
            )
            .await;
        assert_eq!(outcome, UiOutcome::Dismissed);

        let (id, _) = next_ask(&mut events).await;
        assert!(
            !bus.answer(id, Answer::Resolved(json!({ "type": "cancelled" }))),
            "the ask is gone when its timeout ends"
        );
    }

    #[tokio::test]
    async fn an_editor_answer_keeps_its_text() {
        let (bus, mut events) = frontend();

        let asking = tokio::spawn({
            let mut extension = Extension::new(bus.clone(), HostId::new("laptop"), file());
            async move {
                extension
                    .editor(
                        "ask".to_owned(),
                        EditorDialog {
                            title: "Edit".to_owned(),
                            prefill: None,
                        },
                    )
                    .await
            }
        });

        let (id, _) = next_ask(&mut events).await;
        assert!(bus.answer(
            id,
            Answer::Resolved(json!({ "type": "value", "value": "draft" }))
        ));

        assert_eq!(
            asking.await.expect("the ask task lives"),
            UiOutcome::Value("draft".to_owned())
        );
    }

    #[tokio::test]
    async fn a_notice_reaches_the_frontend_with_its_severity() {
        let (bus, mut events) = frontend();
        let mut extension = Extension::new(bus, HostId::new("laptop"), file());

        extension
            .notify(Notice {
                message: "careful".to_owned(),
                notify_type: Some(NoticeKind::Warning),
            })
            .await;

        let (event, payload) = next(&mut events).await;
        assert_eq!(event, ExtensionNotice::EVENT_NAME);
        assert_eq!(
            payload,
            json!({
                "host": "laptop",
                "session": "/home/u/.pi/agent/sessions/a.jsonl",
                "message": "careful",
                "kind": "warning",
            })
        );
    }

    #[tokio::test]
    async fn a_status_a_title_and_editor_text_reach_the_frontend() {
        let (bus, mut events) = frontend();
        let mut extension = Extension::new(bus, HostId::new("laptop"), file());

        extension
            .set_status(StatusEntry {
                status_key: "model".to_owned(),
                status_text: Some("beam".to_owned()),
            })
            .await;
        let (event, payload) = next(&mut events).await;
        assert_eq!(event, ExtensionStatus::EVENT_NAME);
        assert_eq!(
            payload,
            json!({
                "host": "laptop",
                "session": "/home/u/.pi/agent/sessions/a.jsonl",
                "key": "model",
                "text": "beam",
            })
        );

        extension
            .set_title(WindowTitle {
                title: "work".to_owned(),
            })
            .await;
        let (event, payload) = next(&mut events).await;
        assert_eq!(event, ExtensionTitle::EVENT_NAME);
        assert_eq!(payload["title"], "work");

        extension
            .set_editor_text(EditorText {
                text: "draft".to_owned(),
            })
            .await;
        let (event, payload) = next(&mut events).await;
        assert_eq!(event, ExtensionEditorText::EVENT_NAME);
        assert_eq!(payload["text"], "draft");
    }
}
