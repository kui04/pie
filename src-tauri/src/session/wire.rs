//! The payloads pie wraps before the frontend sees them.
//!
//! Pi does not send a value where the frontend reads `{"models": [...]}`: it
//! sends a response envelope whose `data` is that object. [`pi_rpc`] hands back
//! the value inside it, so the wrapping is the job of this layer - and this is
//! where it is written down, once, for every read whose answer is a named shape
//! rather than a record.
//!
//! Everything else crosses unchanged: a `SessionState`, a `SessionStats`, a
//! `BashResult`, a `CompactionResult`, an `EntryList` and the rest already carry
//! the field names of pi's own types, which is what `src/lib/rpc-protocol.ts` names
//! from pi's published TypeScript. A shape written here has to match that source
//! the same way, and `tests/conformance.rs` holds each one against the recorded
//! output of a real pi.

use serde::Serialize;

use pi_rpc::types::{Model, PromptDisposition, QueuedInputDisposition, SlashCommand, ThinkingLevel};

/// Payload of `prompt`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptData {
    /// How the prompt was dispatched.
    pub disposition: PromptDisposition,
}

/// Payload of `steer` and `follow_up`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputData {
    /// How the message was dispatched.
    pub disposition: QueuedInputDisposition,
}

/// Payload of `get_available_models`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModelsData {
    /// Models pi can use.
    pub models: Vec<Model>,
}

/// Payload of `get_available_thinking_levels`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableThinkingLevelsData {
    /// Levels this session accepts.
    pub levels: Vec<ThinkingLevel>,
}

/// Payload of `get_last_assistant_text`.
///
/// Pi omits `text` entirely when the session has no assistant message yet - the
/// recorded fixtures show `data: {}` - so the key is left out rather than sent
/// as `null`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAssistantTextData {
    /// Text of the last assistant message, absent when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Payload of `get_commands`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsData {
    /// Commands a prompt can invoke.
    pub commands: Vec<SlashCommand>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wrapper is what pi writes between the braces of `data`, and the
    /// frontend reads those names: a field renamed here arrives as a field that
    /// is quietly never there.
    #[test]
    fn a_wrapped_payload_carries_the_field_names_pi_writes() {
        let crossing = serde_json::to_value(PromptData {
            disposition: PromptDisposition::Started,
        })
        .expect("a payload serializes");
        assert_eq!(crossing, serde_json::json!({ "disposition": "started" }));

        let crossing = serde_json::to_value(AvailableThinkingLevelsData {
            levels: vec![ThinkingLevel::Off, ThinkingLevel::Max],
        })
        .expect("a payload serializes");
        assert_eq!(crossing, serde_json::json!({ "levels": ["off", "max"] }));

        let crossing = serde_json::to_value(LastAssistantTextData::default()).expect("a payload serializes");
        assert_eq!(crossing, serde_json::json!({}), "pi omits an answer it does not have");
    }
}
