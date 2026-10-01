//! Extension dialogs and extension failures.
//!
//! Mirrors `RpcExtensionUIRequest`, `RpcExtensionUIResponse` and the
//! `extension_error` record from `packages/coding-agent/src/modes/rpc/rpc-types.ts`
//! and `rpc-mode.ts`. Pi asks the client for input with an
//! `extension_ui_request` and expects an `extension_ui_response` on stdin;
//! `notify`, `setStatus`, `setWidget` and `setTitle` expect no answer.

use serde::{Deserialize, Serialize};

/// What kind of notification pi is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum NotifyType {
    /// Informational.
    Info,
    /// Warning.
    Warning,
    /// Error.
    Error,
}

/// Where a widget is placed relative to the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum WidgetPlacement {
    /// Above the editor.
    AboveEditor,
    /// Below the editor.
    BelowEditor,
}

/// The body of an [`ExtensionUiRequest`], tagged on `method`.
///
/// `method` casing is pi's: mostly camelCase, with `set_editor_text` in
/// snake_case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[non_exhaustive]
pub enum ExtensionUiRequestKind {
    /// Pick one of the options.
    Select {
        /// Dialog title.
        title: String,
        /// Options to choose from.
        options: Vec<String>,
        /// Milliseconds before pi gives up.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    /// Ask a yes/no question.
    Confirm {
        /// Dialog title.
        title: String,
        /// Question text.
        message: String,
        /// Milliseconds before pi gives up.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    /// Read a line of text.
    Input {
        /// Dialog title.
        title: String,
        /// Placeholder shown in the field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        /// Milliseconds before pi gives up.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    /// Open a multi-line editor.
    Editor {
        /// Dialog title.
        title: String,
        /// Initial text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefill: Option<String>,
    },
    /// Show a notification. Fire and forget.
    Notify {
        /// Notification text.
        message: String,
        /// Severity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notify_type: Option<NotifyType>,
    },
    /// Set or clear a status line. Fire and forget.
    #[serde(rename = "setStatus")]
    SetStatus {
        /// Key that identifies the status line.
        status_key: String,
        /// Text to show, absent to clear the status.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status_text: Option<String>,
    },
    /// Set or clear a widget. Fire and forget.
    #[serde(rename = "setWidget")]
    SetWidget {
        /// Key that identifies the widget.
        widget_key: String,
        /// Lines to show, absent to clear the widget.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        widget_lines: Option<Vec<String>>,
        /// Where to place the widget.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        widget_placement: Option<WidgetPlacement>,
    },
    /// Set the terminal title. Fire and forget.
    #[serde(rename = "setTitle")]
    SetTitle {
        /// New title.
        title: String,
    },
    /// Replace the editor contents. Fire and forget.
    #[serde(rename = "set_editor_text")]
    SetEditorText {
        /// New text.
        text: String,
    },
}

/// The value pi writes into the `type` field of an [`ExtensionUiRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ExtensionUiRequestTag {
    /// An extension UI request.
    ExtensionUiRequest,
}

/// A dialog or status update pi sent on stdout (`RpcExtensionUIRequest`).
///
/// Answer the ones that ask a question with [`ExtensionUiResponse`]; `notify`,
/// `setStatus`, `setWidget` and `setTitle` need no answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionUiRequest {
    /// Record kind.
    #[serde(rename = "type")]
    pub message_type: ExtensionUiRequestTag,
    /// Dialog id to echo back in the response.
    pub id: String,
    /// What pi is asking for.
    #[serde(flatten)]
    pub request: ExtensionUiRequestKind,
}

/// The value pi writes into the `type` field of an [`ExtensionUiResponse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ExtensionUiResponseTag {
    /// An extension UI response.
    ExtensionUiResponse,
}

/// An answer to an [`ExtensionUiRequest`] (`RpcExtensionUIResponse`).
///
/// Pi's three shapes are mutually exclusive: a value, a confirmation, or a
/// cancellation. Build them with [`ExtensionUiResponse::value`],
/// [`ExtensionUiResponse::confirm`] and [`ExtensionUiResponse::cancel`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
#[non_exhaustive]
pub enum ExtensionUiResponse {
    /// Answer to `select`, `input` and `editor`.
    Value {
        /// Record kind.
        #[serde(rename = "type")]
        message_type: ExtensionUiResponseTag,
        /// Dialog id from the request.
        id: String,
        /// The chosen or entered value.
        value: String,
    },
    /// Answer to `confirm`.
    Confirm {
        /// Record kind.
        #[serde(rename = "type")]
        message_type: ExtensionUiResponseTag,
        /// Dialog id from the request.
        id: String,
        /// Whether the user confirmed.
        confirmed: bool,
    },
    /// Answer to any dialog the user dismissed.
    Cancel {
        /// Record kind.
        #[serde(rename = "type")]
        message_type: ExtensionUiResponseTag,
        /// Dialog id from the request.
        id: String,
        /// Always `true`.
        cancelled: bool,
    },
}

impl ExtensionUiResponse {
    /// Answers a `select`, `input` or `editor` request with a value.
    pub fn value(id: impl Into<String>, value: impl Into<String>) -> Self {
        Self::Value {
            message_type: ExtensionUiResponseTag::ExtensionUiResponse,
            id: id.into(),
            value: value.into(),
        }
    }

    /// Answers a `confirm` request.
    pub fn confirm(id: impl Into<String>, confirmed: bool) -> Self {
        Self::Confirm {
            message_type: ExtensionUiResponseTag::ExtensionUiResponse,
            id: id.into(),
            confirmed,
        }
    }

    /// Dismisses a request.
    pub fn cancel(id: impl Into<String>) -> Self {
        Self::Cancel {
            message_type: ExtensionUiResponseTag::ExtensionUiResponse,
            id: id.into(),
            cancelled: true,
        }
    }

    /// Id of the dialog this answers.
    pub fn id(&self) -> &str {
        match self {
            Self::Value { id, .. } | Self::Confirm { id, .. } | Self::Cancel { id, .. } => id,
        }
    }
}

/// The value pi writes into the `type` field of an [`ExtensionError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ExtensionErrorTag {
    /// An extension failure.
    ExtensionError,
}

/// An extension handler failure pi reported on stdout.
///
/// Pi drops the stack it holds internally when it writes this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionError {
    /// Record kind.
    #[serde(rename = "type")]
    pub message_type: ExtensionErrorTag,
    /// Path of the failing extension.
    pub extension_path: String,
    /// Event the extension was handling.
    pub event: String,
    /// Error text.
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_status_update_without_text() {
        let wire =
            r#"{"type":"extension_ui_request","id":"5","method":"setStatus","statusKey":"pi-permission-system"}"#;
        let request: ExtensionUiRequest = serde_json::from_str(wire).unwrap();
        assert_eq!(
            request.request,
            ExtensionUiRequestKind::SetStatus {
                status_key: "pi-permission-system".to_string(),
                status_text: None,
            }
        );
        assert_eq!(serde_json::to_string(&request).unwrap(), wire);
    }

    #[test]
    fn parses_every_dialog_method() {
        for wire in [
            r#"{"type":"extension_ui_request","id":"1","method":"select","title":"t","options":["a"]}"#,
            r#"{"type":"extension_ui_request","id":"2","method":"confirm","title":"t","message":"m"}"#,
            r#"{"type":"extension_ui_request","id":"3","method":"input","title":"t","placeholder":"p"}"#,
            r#"{"type":"extension_ui_request","id":"4","method":"editor","title":"t","prefill":"x"}"#,
            r#"{"type":"extension_ui_request","id":"5","method":"notify","message":"m","notifyType":"warning"}"#,
            r#"{"type":"extension_ui_request","id":"6","method":"setWidget","widgetKey":"k","widgetLines":["a"],"widgetPlacement":"aboveEditor"}"#,
            r#"{"type":"extension_ui_request","id":"7","method":"setTitle","title":"t"}"#,
            r#"{"type":"extension_ui_request","id":"8","method":"set_editor_text","text":"t"}"#,
        ] {
            let request: ExtensionUiRequest = serde_json::from_str(wire).unwrap();
            assert_eq!(serde_json::to_string(&request).unwrap(), wire);
        }
    }

    #[test]
    fn serializes_the_three_response_shapes() {
        assert_eq!(
            serde_json::to_string(&ExtensionUiResponse::value("1", "yes")).unwrap(),
            r#"{"type":"extension_ui_response","id":"1","value":"yes"}"#
        );
        assert_eq!(
            serde_json::to_string(&ExtensionUiResponse::confirm("2", false)).unwrap(),
            r#"{"type":"extension_ui_response","id":"2","confirmed":false}"#
        );
        assert_eq!(
            serde_json::to_string(&ExtensionUiResponse::cancel("3")).unwrap(),
            r#"{"type":"extension_ui_response","id":"3","cancelled":true}"#
        );
    }
}
