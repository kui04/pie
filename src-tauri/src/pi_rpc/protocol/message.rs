//! Conversation messages and content parts.
//!
//! Mirrors `Message`, `SystemMessage`, `UserMessage`, `AssistantMessage`,
//! `ToolResultMessage`, the content-part types, and `StopReason` from
//! `packages/ai/src/types.ts` / `packages/agent/src/types.ts`. Pi lets
//! applications extend `AgentMessage` through TS declaration merging, so an
//! unknown role cannot be represented here; such a message makes its whole
//! record fall back to [`crate::pi_rpc::protocol::ServerMessage::Unknown`] instead of
//! failing the connection.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::model::{ModelThinkingLevel, Usage};

/// Plain text content part (`TextContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct TextContent {
    /// Part kind; always `text`.
    #[serde(rename = "type")]
    pub part_type: TextPartType,
    /// The text.
    pub text: String,
    /// Provider-specific text metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_signature: Option<String>,
}

/// The single value pi writes in [`TextContent::part_type`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum TextPartType {
    /// Text.
    Text,
}

/// Reasoning text content part (`ThinkingContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ThinkingContent {
    /// Part kind; always `thinking`.
    #[serde(rename = "type")]
    pub part_type: ThinkingPartType,
    /// The reasoning text.
    pub thinking: String,
    /// Provider-specific replay data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    /// Whether safety filters redacted this content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
}

/// The single value pi writes in [`ThinkingContent::part_type`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ThinkingPartType {
    /// Reasoning text.
    Thinking,
}

/// Base64 image content part (`ImageContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    /// Part kind; always `image`.
    #[serde(rename = "type")]
    pub part_type: ImagePartType,
    /// Base64 encoded image data.
    pub data: String,
    /// MIME type, e.g. `image/png`.
    pub mime_type: String,
}

/// The single value pi writes in [`ImageContent::part_type`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ImagePartType {
    /// Image data.
    Image,
}

/// A tool call requested by the assistant (`ToolCall`).
///
/// The tag is `toolCall` - camelCase, unlike the other part tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// Part kind; always `toolCall`.
    #[serde(rename = "type")]
    pub part_type: ToolCallPartType,
    /// Tool call id.
    pub id: String,
    /// Tool name.
    pub name: String,
    /// Arguments as the model produced them.
    pub arguments: serde_json::Map<String, serde_json::Value>,
    /// Google-specific opaque thought signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
    /// OpenAI Responses namespace for namespaced tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// The single value pi writes in [`ToolCall::part_type`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[non_exhaustive]
pub enum ToolCallPartType {
    /// A tool call.
    #[serde(rename = "toolCall")]
    ToolCall,
}

/// A content part of a user message: text or image (`TextContent | ImageContent`).
///
/// Untagged on purpose: each part struct carries pi's literal `type`, and that is
/// what discriminates the union. Tagging the enum instead would consume the field
/// the struct needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
#[non_exhaustive]
pub enum UserContentPart {
    /// Text.
    #[serde(rename = "text")]
    Text(TextContent),
    /// Image.
    #[serde(rename = "image")]
    Image(ImageContent),
}

/// A content part of an assistant message
/// (`TextContent | ThinkingContent | ToolCall`).
///
/// Untagged for the same reason as [`UserContentPart`]: the literal `type` lives
/// on the part structs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
#[non_exhaustive]
pub enum AssistantContentPart {
    /// Text.
    #[serde(rename = "text")]
    Text(TextContent),
    /// Reasoning text.
    #[serde(rename = "thinking")]
    Thinking(ThinkingContent),
    /// Tool call.
    #[serde(rename = "toolCall")]
    ToolCall(ToolCall),
}

/// A content part of a tool result (`TextContent | ImageContent`).
///
/// Untagged for the same reason as [`UserContentPart`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
#[non_exhaustive]
pub enum ToolResultContentPart {
    /// Text.
    #[serde(rename = "text")]
    Text(TextContent),
    /// Image.
    #[serde(rename = "image")]
    Image(ImageContent),
}

/// Any content part that a context edit may carry (`ContextEditableContent`
/// element).
///
/// Untagged for the same reason as [`UserContentPart`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
#[non_exhaustive]
pub enum EditableContentPart {
    /// Text.
    #[serde(rename = "text")]
    Text(TextContent),
    /// Reasoning text.
    #[serde(rename = "thinking")]
    Thinking(ThinkingContent),
    /// Image.
    #[serde(rename = "image")]
    Image(ImageContent),
    /// Tool call.
    #[serde(rename = "toolCall")]
    ToolCall(ToolCall),
}

/// A system message body: a bare string or text parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
pub enum SystemContent {
    /// A single string.
    Text(String),
    /// Text parts.
    Parts(Vec<TextContent>),
}

/// A user message body: a bare string or text/image parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
pub enum UserContent {
    /// A single string.
    Text(String),
    /// Text and image parts.
    Parts(Vec<UserContentPart>),
}

/// Content an append-only context edit may replace
/// (`ContextEditableContent` in `session-manager.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(untagged)]
pub enum EditableContent {
    /// A single string.
    Text(String),
    /// Content parts.
    Parts(Vec<EditableContentPart>),
}

/// Why an assistant response stopped (`StopReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[non_exhaustive]
pub enum StopReason {
    /// Still streaming.
    #[serde(rename = "pending")]
    Pending,
    /// Natural stop.
    #[serde(rename = "stop")]
    Stop,
    /// Output token limit reached.
    #[serde(rename = "length")]
    Length,
    /// The model requested tools.
    #[serde(rename = "toolUse")]
    ToolUse,
    /// Provider error.
    #[serde(rename = "error")]
    Error,
    /// Aborted by the client.
    #[serde(rename = "aborted")]
    Aborted,
    /// Deferred to a later turn.
    #[serde(rename = "deferred")]
    Deferred,
}

/// One nested tool call a tool made while it ran (`NestedToolCallRecord`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct NestedToolCallRecord {
    /// Tool call id.
    pub id: String,
    /// Tool name.
    pub name: String,
    /// Arguments, omitted when they exceeded the size limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
    /// UTF-8 size of the arguments when they were omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments_bytes: Option<u64>,
    /// Outcome of the nested call.
    pub status: NestedToolCallStatus,
    /// How long it ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Truncated error text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Outcome of a nested tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum NestedToolCallStatus {
    /// Finished successfully.
    Ok,
    /// Failed.
    Error,
    /// Still running when the calling tool finished.
    Unfinished,
}

/// Bounded record of the nested calls a tool made (`NestedToolCalls`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct NestedToolCalls {
    /// The recorded calls.
    pub calls: Vec<NestedToolCallRecord>,
    /// False when calls were dropped or had not finished.
    pub complete: bool,
}

/// Instructions replayed into the context (`SystemMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct SystemMessage {
    /// Instruction text.
    pub content: SystemContent,
    /// Named prompt sections; `null` removes a section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<BTreeMap<String, Option<String>>>,
    /// Tool definitions that become available here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_added: Option<serde_json::Value>,
    /// Tools that stop being available here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_removed: Option<serde_json::Value>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// A user turn (`UserMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    /// Message text or parts.
    pub content: UserContent,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// An assistant turn (`AssistantMessage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    /// Text, reasoning, and tool calls.
    pub content: Vec<AssistantContentPart>,
    /// API implementation that served the response.
    pub api: String,
    /// Provider that served the response.
    pub provider: String,
    /// Requested model id.
    pub model: String,
    /// Concrete model the provider reported, when different.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Provider response identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    /// Provider-native effort level used for this response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thinking_level: Option<String>,
    /// Pi thinking level the agent loop requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ModelThinkingLevel>,
    /// Redacted provider or runtime diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<serde_json::Value>,
    /// Token usage.
    pub usage: Usage,
    /// Why the response stopped.
    pub stop_reason: StopReason,
    /// Handle of a deferred response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<serde_json::Value>,
    /// Error text when the response failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Raw provider stop reason, kept for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_stop_reason: Option<String>,
    /// Provider indication that the model ended its turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_turn: Option<bool>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// The result of one tool call (`ToolResultMessage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    /// Id of the call this answers.
    pub tool_call_id: String,
    /// Name of the tool that ran.
    pub tool_name: String,
    /// Text and image results.
    pub content: Vec<ToolResultContentPart>,
    /// Tool-specific details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// Usage of the tool execution itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Calls this tool made to other tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nested_calls: Option<NestedToolCalls>,
    /// Whether the tool failed.
    pub is_error: bool,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// A shell execution kept in the transcript (`BashExecutionMessage`, one of the
/// roles `packages/coding-agent/src/core/messages.ts` adds to
/// `CustomAgentMessages`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct BashExecutionMessage {
    /// The command line.
    pub command: String,
    /// Combined stdout and stderr.
    pub output: String,
    /// Exit code; absent when the process was killed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Whether a signal cancelled the command.
    pub cancelled: bool,
    /// Whether the output was truncated.
    pub truncated: bool,
    /// File holding the untruncated output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
    /// Whether the message stays out of the model context (`!!` prefix).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_from_context: Option<bool>,
}

/// A message an extension injected into the conversation (`CustomMessage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct CustomMessage {
    /// Extension-defined message kind.
    pub custom_type: String,
    /// Message content.
    pub content: EditableContent,
    /// Whether pi renders the message with distinct styling.
    pub display: bool,
    /// Extension-specific metadata, not sent to the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// A summary of a branch that was abandoned (`BranchSummaryMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryMessage {
    /// The generated summary.
    pub summary: String,
    /// Entry the branch came from; `null` when pi cannot tell.
    pub from_id: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// A summary that replaced compacted history (`CompactionSummaryMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(rename_all = "camelCase")]
pub struct CompactionSummaryMessage {
    /// The generated summary.
    pub summary: String,
    /// Tokens before compaction.
    pub tokens_before: u64,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

/// One message in a session (`AgentMessage`).
///
/// The variant is the `role` field. Besides the four core roles,
/// `packages/coding-agent/src/core/messages.ts` adds `bashExecution`, `custom`,
/// `branchSummary` and `compactionSummary` through TS declaration merging, and
/// they are mirrored here. A role from an unknown extension still degrades to an
/// unknown record rather than breaking the connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "index.ts")]
#[serde(tag = "role", rename_all = "camelCase")]
#[non_exhaustive]
pub enum AgentMessage {
    /// Instructions replayed into the context.
    System(SystemMessage),
    /// A user turn.
    User(UserMessage),
    /// An assistant turn.
    Assistant(AssistantMessage),
    /// The result of one tool call.
    ToolResult(ToolResultMessage),
    /// A shell execution from the `!` command.
    BashExecution(BashExecutionMessage),
    /// A message an extension injected.
    Custom(CustomMessage),
    /// A summary of an abandoned branch.
    BranchSummary(BranchSummaryMessage),
    /// A summary that replaced compacted history.
    CompactionSummary(CompactionSummaryMessage),
}
