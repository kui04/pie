//! The append-only session tree.
//!
//! Mirrors `SessionEntry`, its eleven variants, and `SessionTreeNode` from
//! `packages/coding-agent/src/core/session-manager.ts`. Pi models each variant as
//! `SessionEntryBase & { type: ...; ... }`, so the base fields (`id`, `parentId`,
//! `timestamp`) are repeated in every variant here exactly as they appear on the
//! wire.

use serde::{Deserialize, Serialize};

use super::message::{AgentMessage, EditableContent, SystemMessage};
use super::model::Usage;

/// A `message` entry: one conversation message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// The message.
    pub message: AgentMessage,
}

/// A `thinking_level_change` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ThinkingLevelChangeEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Thinking level as pi stored it (`ModelThinkingLevel` values appear here).
    pub thinking_level: String,
}

/// A `model_change` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ModelChangeEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model_id: String,
}

/// A `usage` entry: usage outside the main conversation, e.g. cache warming.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Usage category, e.g. `cache_warm`.
    pub kind: String,
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// The usage record.
    pub usage: Usage,
    /// Human-readable qualifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A `compaction` entry: a summary that replaced earlier history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct CompactionEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// The generated summary.
    pub summary: String,
    /// First entry kept after compaction.
    pub first_kept_entry_id: String,
    /// Tokens before compaction.
    pub tokens_before: u64,
    /// Extension-specific data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// Usage of the LLM call that produced the summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// True when an extension generated this entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_hook: Option<bool>,
    /// Complete prompt and tool state at this compaction boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_message: Option<SystemMessage>,
}

/// A `branch_summary` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Entry the branch came from.
    pub from_id: String,
    /// The generated summary.
    pub summary: String,
    /// Extension-specific data, not sent to the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// Usage of the LLM call that produced the summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// True when an extension generated this entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_hook: Option<bool>,
}

/// A `custom` entry: extension state, never sent to the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct CustomEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Extension-defined entry kind.
    pub custom_type: String,
    /// Extension-defined payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// A `custom_message` entry: extension content that does enter the context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct CustomMessageEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Extension-defined message kind.
    pub custom_type: String,
    /// Message content.
    pub content: EditableContent,
    /// Extension-specific metadata, not sent to the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// Whether pi renders the message with distinct styling.
    pub display: bool,
}

/// Replacement carried by a `context_edit` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
pub struct ContextEditReplacement {
    /// Replacement content for the target entry.
    pub content: EditableContent,
}

/// A `context_edit` entry: an append-only change to earlier context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ContextEditEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Entry this edit applies to.
    pub target_id: String,
    /// Replacement content, or `null` to omit the target from context.
    pub replacement: Option<ContextEditReplacement>,
}

/// A `label` entry: a user-defined marker on another entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct LabelEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Entry the label points at.
    pub target_id: String,
    /// The label text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A `session_info` entry: session metadata such as a display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionInfoEntry {
    /// Entry id.
    pub id: String,
    /// Parent entry id; `null` at the root.
    pub parent_id: Option<String>,
    /// ISO timestamp.
    pub timestamp: String,
    /// Display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// One entry of the session tree (`SessionEntry`).
///
/// The variant is the `type` field. Unknown entry kinds - extensions may add
/// their own through pi's session API - degrade to an unknown record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum SessionEntry {
    /// A conversation message.
    Message(SessionMessageEntry),
    /// The thinking level changed.
    ThinkingLevelChange(ThinkingLevelChangeEntry),
    /// The model changed.
    ModelChange(ModelChangeEntry),
    /// Usage recorded outside the conversation.
    Usage(UsageEntry),
    /// History was compacted into a summary.
    Compaction(CompactionEntry),
    /// A branch was summarized.
    BranchSummary(BranchSummaryEntry),
    /// Extension state.
    Custom(CustomEntry),
    /// Extension message that enters the context.
    CustomMessage(CustomMessageEntry),
    /// An append-only edit to earlier context.
    ContextEdit(ContextEditEntry),
    /// A marker on another entry.
    Label(LabelEntry),
    /// Session metadata.
    SessionInfo(SessionInfoEntry),
}

/// One node of the session tree (`SessionTreeNode`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionTreeNode {
    /// The entry this node wraps.
    pub entry: SessionEntry,
    /// Child nodes.
    pub children: Vec<SessionTreeNode>,
    /// Resolved label of this entry, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Timestamp of the latest label change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_timestamp: Option<String>,
}
