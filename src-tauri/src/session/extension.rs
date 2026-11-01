//! The extension dialogs and notices of one session.

use std::time::Duration;

use pi_rpc::extui::{
    ConfirmDialog, EditorDialog, EditorText, InputDialog, Notice, NoticeKind, SelectDialog,
    StatusEntry, UiAnswer, UiHandler, UiOutcome, UiRequest, WindowTitle,
};
use serde::{Deserialize, Serialize};
use typed_path::Utf8TypedPathBuf;

use crate::bus::{Ask, Bus, Notification};
use crate::state::HostId;

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
