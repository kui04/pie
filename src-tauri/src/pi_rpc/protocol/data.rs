//! Payloads of successful responses, one type per command.
//!
//! Decode them with [`super::Response::decode`]. Commands that answer without a
//! payload (`abort`, `set_thinking_level`, `set_steering_mode`,
//! `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`,
//! `abort_bash`, `set_session_name`) have no type here.
//!
//! | command | payload |
//! | --- | --- |
//! | `prompt` | [`PromptData`] |
//! | `steer`, `follow_up` | [`QueuedInputData`] |
//! | `clear_queue` | [`ClearQueueData`] |
//! | `new_session` | [`NewSessionData`] |
//! | `get_state` | [`super::SessionState`] |
//! | `set_model` | [`super::Model`] |
//! | `cycle_model` | [`CycleModelData`], `null` when there is nothing to cycle |
//! | `get_available_models` | [`AvailableModelsData`] |
//! | `cycle_thinking_level` | [`CycleThinkingLevelData`], `null` when there is nothing to cycle |
//! | `get_available_thinking_levels` | [`AvailableThinkingLevelsData`] |
//! | `compact` | [`super::CompactionResult`] |
//! | `bash` | [`super::BashResult`] |
//! | `get_session_stats` | [`super::SessionStats`] |
//! | `export_html` | [`ExportHtmlData`] |
//! | `switch_session` | [`SwitchSessionData`] |
//! | `fork` | [`ForkData`] |
//! | `clone` | [`CloneData`] |
//! | `get_fork_messages` | [`ForkMessagesData`] |
//! | `get_entries` | [`EntriesData`] |
//! | `get_tree` | [`TreeData`] |
//! | `get_last_assistant_text` | [`LastAssistantTextData`] |
//! | `get_messages` | [`MessagesData`] |
//! | `get_commands` | [`CommandsData`] |

use serde::{Deserialize, Serialize};

use super::message::AgentMessage;
use super::misc::{ForkMessage, PromptDisposition, QueuedInputDisposition, SlashCommand};
use super::model::{Model, ModelThinkingLevel};
use super::session_entry::{SessionEntry, SessionTreeNode};

/// Payload of `prompt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptData {
    /// How the prompt was dispatched.
    pub disposition: PromptDisposition,
}

/// Payload of `steer` and `follow_up`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputData {
    /// How the message was dispatched.
    pub disposition: QueuedInputDisposition,
}

/// Payload of `clear_queue`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearQueueData {
    /// Steering messages that were dropped.
    pub steering: Vec<String>,
    /// Follow-up messages that were dropped.
    pub follow_up: Vec<String>,
}

/// Payload of `new_session`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionData {
    /// Whether a running operation was cancelled.
    pub cancelled: bool,
}

/// Payload of `cycle_model`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleModelData {
    /// The model that became active.
    pub model: Model,
    /// Thinking level after cycling.
    pub thinking_level: ModelThinkingLevel,
    /// Whether the change is scoped to this session.
    pub is_scoped: bool,
}

/// Payload of `get_available_models`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModelsData {
    /// Models pi can use.
    pub models: Vec<Model>,
}

/// Payload of `cycle_thinking_level`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleThinkingLevelData {
    /// The level that became active.
    pub level: ModelThinkingLevel,
}

/// Payload of `get_available_thinking_levels`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableThinkingLevelsData {
    /// Levels this session accepts.
    pub levels: Vec<ModelThinkingLevel>,
}

/// Payload of `export_html`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHtmlData {
    /// File pi wrote.
    pub path: String,
}

/// Payload of `switch_session`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchSessionData {
    /// Whether a running operation was cancelled.
    pub cancelled: bool,
}

/// Payload of `fork`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkData {
    /// Text of the entry the fork started from.
    pub text: String,
    /// Whether a running operation was cancelled.
    pub cancelled: bool,
}

/// Payload of `clone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneData {
    /// Whether a running operation was cancelled.
    pub cancelled: bool,
}

/// Payload of `get_fork_messages`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkMessagesData {
    /// Entries a fork can start from.
    pub messages: Vec<ForkMessage>,
}

/// Payload of `get_entries`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntriesData {
    /// Session entries.
    pub entries: Vec<SessionEntry>,
    /// Id of the current leaf, `null` in an empty session.
    pub leaf_id: Option<String>,
}

/// Payload of `get_tree`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeData {
    /// Roots of the session tree.
    pub tree: Vec<SessionTreeNode>,
    /// Id of the current leaf, `null` in an empty session.
    pub leaf_id: Option<String>,
}

/// Payload of `get_last_assistant_text`.
///
/// Pi omits `text` entirely when the session has no assistant message yet; the
/// recorded fixtures show `data: {}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAssistantTextData {
    /// Text of the last assistant message, absent when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Payload of `get_messages`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesData {
    /// Conversation messages.
    pub messages: Vec<AgentMessage>,
}

/// Payload of `get_commands`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsData {
    /// Commands a prompt can invoke.
    pub commands: Vec<SlashCommand>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Field names on the wire are pi's, not ours. This table pins the spelling of
    /// every payload the recorded corpus never reaches: a wrong field name in this
    /// layer degrades to `ServerMessage::Unknown` at runtime, which is exactly how
    /// the kebab-case `origin: "top-level"` was caught.
    #[test]
    fn payload_field_names_match_the_wire() {
        macro_rules! decode {
            ($type:ty, $json:tt) => {{
                serde_json::from_value::<$type>(serde_json::json!($json))
                    .unwrap_or_else(|error| panic!("{}: {error}", stringify!($type)))
            }};
        }

        assert_eq!(
            decode!(PromptData, { "disposition": "started" }).disposition,
            PromptDisposition::Started
        );
        assert_eq!(
            decode!(QueuedInputData, { "disposition": "handled" }).disposition,
            QueuedInputDisposition::Handled
        );

        let cleared = decode!(ClearQueueData, { "steering": ["a"], "followUp": ["b"] });
        assert_eq!(cleared.steering, vec!["a"]);
        assert_eq!(cleared.follow_up, vec!["b"]);

        assert!(decode!(NewSessionData, { "cancelled": true }).cancelled);
        assert!(!decode!(SwitchSessionData, { "cancelled": false }).cancelled);
        assert!(decode!(CloneData, { "cancelled": true }).cancelled);

        assert_eq!(
            decode!(ExportHtmlData, { "path": "/tmp/session.html" }).path,
            "/tmp/session.html"
        );

        let forked = decode!(ForkData, { "text": "hi", "cancelled": true });
        assert_eq!(forked.text, "hi");
        assert!(forked.cancelled);

        let forks = decode!(ForkMessagesData, { "messages": [{ "entryId": "e1", "text": "hi" }] });
        assert_eq!(forks.messages[0].entry_id, "e1");
        assert_eq!(forks.messages[0].text, "hi");

        // A full model entry, because `CycleModelData` embeds one.
        let model = serde_json::json!({
            "id": "deepseek-flash",
            "name": "DeepSeek Flash",
            "api": "openai-completions",
            "provider": "deepseek",
            "baseUrl": "https://api.deepseek.com",
            "input": ["text"],
            "reasoning": true,
            "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.03, "cacheWrite": 0.0 },
            "contextWindow": 1000000,
            "maxTokens": 384000
        });
        let cycled = decode!(CycleModelData, {
            "model": model,
            "thinkingLevel": "high",
            "isScoped": true
        });
        assert!(cycled.is_scoped);
        assert_eq!(cycled.thinking_level, ModelThinkingLevel::High);
        assert_eq!(cycled.model.id, "deepseek-flash");
    }
}
