//! Session statistics, bash results, compaction results, and source metadata.
//!
//! Mirrors `SessionStats`, `BashResult`, `CompactionResult`, `SourceInfo` and
//! `RpcSlashCommand` from the pinned checkout.

use serde::{Deserialize, Serialize};

use super::model::Usage;

/// Where a resource comes from (`SourceScope`).
///
/// Values are pi's literals, spelled out rather than derived from a rename rule:
/// the `top-level` origin is evidence that these unions mix word styles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SourceScope {
    /// Installed for the user.
    #[serde(rename = "user")]
    User,
    /// Belongs to the project.
    #[serde(rename = "project")]
    Project,
    /// Temporary.
    #[serde(rename = "temporary")]
    Temporary,
}

/// How a resource was resolved (`SourceOrigin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SourceOrigin {
    /// Came from an installed package.
    #[serde(rename = "package")]
    Package,
    /// Top-level path or built-in.
    #[serde(rename = "top-level")]
    TopLevel,
}

/// Metadata of the resource that owns a command (`SourceInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// Absolute path of the resource.
    pub path: String,
    /// Source identifier, e.g. `npm:pi-permission-system`.
    pub source: String,
    /// Scope the resource was loaded from.
    pub scope: SourceScope,
    /// How the resource was resolved.
    pub origin: SourceOrigin,
    /// Base directory for relative paths, when the source has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

/// What kind of thing provides a slash command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum SlashCommandSource {
    /// An extension.
    Extension,
    /// A prompt template.
    Prompt,
    /// A skill.
    Skill,
}

/// A command that can be invoked through a prompt (`RpcSlashCommand`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Command name without the leading slash.
    pub name: String,
    /// Human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// What provides the command.
    pub source: SlashCommandSource,
    /// Metadata of the providing resource.
    pub source_info: SourceInfo,
}

/// Token totals of a session (`SessionStats["tokens"]`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    /// Input tokens.
    pub input: u64,
    /// Output tokens.
    pub output: u64,
    /// Cached input tokens read.
    pub cache_read: u64,
    /// Input tokens written to cache.
    pub cache_write: u64,
    /// Total tokens.
    pub total: u64,
}

/// How full the context window is (`ContextUsage`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// Estimated context tokens, or `null` while unknown (e.g. right after compaction).
    pub tokens: Option<u64>,
    /// Size of the context window.
    pub context_window: u64,
    /// Usage as a percentage, or `null` while unknown.
    pub percent: Option<f64>,
}

/// Aggregate statistics of a session (`SessionStats`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// Path of the session file; absent when the session is not persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    /// Session id.
    pub session_id: String,
    /// Number of user messages.
    pub user_messages: u64,
    /// Number of assistant messages.
    pub assistant_messages: u64,
    /// Number of tool calls.
    pub tool_calls: u64,
    /// Number of tool results.
    pub tool_results: u64,
    /// Total number of messages.
    pub total_messages: u64,
    /// Token totals.
    pub tokens: SessionTokens,
    /// Accumulated cost.
    pub cost: f64,
    /// Context usage, when pi can estimate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsage>,
}

/// Result of running a shell command through pi (`BashResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashResult {
    /// Combined stdout and stderr, sanitized and possibly truncated.
    pub output: String,
    /// Exit code; absent when the command was killed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Whether a signal cancelled the command.
    pub cancelled: bool,
    /// Whether the output was truncated.
    pub truncated: bool,
    /// File holding the untruncated output, when truncation happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
}

/// Result of compacting the conversation (`CompactionResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionResult {
    /// The generated summary.
    pub summary: String,
    /// First entry kept after compaction.
    pub first_kept_entry_id: String,
    /// Tokens before compaction.
    pub tokens_before: u64,
    /// Estimated tokens after compaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_tokens_after: Option<u64>,
    /// Usage of the LLM call that produced the summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Extension-specific data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// How pi dispatched an accepted prompt (`PromptDisposition`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum PromptDisposition {
    /// The message started a run.
    Started,
    /// The message was queued.
    Queued,
    /// The message was handled without a run.
    Handled,
}

/// How pi dispatched queued input (`QueuedInputDisposition`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum QueuedInputDisposition {
    /// The message was queued.
    Queued,
    /// The message was handled without a run.
    Handled,
}

/// One entry offered for forking (`get_fork_messages`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkMessage {
    /// Entry the fork would start from.
    pub entry_id: String,
    /// Text of that entry.
    pub text: String,
}
