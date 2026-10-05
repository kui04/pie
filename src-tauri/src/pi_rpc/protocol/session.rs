//! Session state.
//!
//! Mirrors `RpcSessionState` from `packages/coding-agent/src/modes/rpc/rpc-types.ts`.

use serde::{Deserialize, Serialize};

use super::command::QueueMode;
use super::model::{Model, ModelThinkingLevel};

/// The state of the session behind a connection (`RpcSessionState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// Active model, absent before a model is resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Model>,
    /// Active thinking level.
    pub thinking_level: ModelThinkingLevel,
    /// Whether a run is streaming.
    pub is_streaming: bool,
    /// Whether compaction is running.
    pub is_compacting: bool,
    /// How steering messages are drained.
    pub steering_mode: QueueMode,
    /// How follow-up messages are drained.
    pub follow_up_mode: QueueMode,
    /// Path of the session file, absent when the session is not persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    /// Session id.
    pub session_id: String,
    /// Session display name, absent when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// Whether automatic compaction is on.
    pub auto_compaction_enabled: bool,
    /// Number of messages in the session.
    pub message_count: u64,
    /// Number of queued messages.
    pub pending_message_count: u64,
}
