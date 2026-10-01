//! Wire types mirrored from the pinned Pi checkout.
//!
//! Sources of truth, in order: `packages/coding-agent/src/modes/rpc/rpc-types.ts`,
//! `rpc-mode.ts`, `jsonl.ts`, `packages/coding-agent/src/modes/json-event.ts` and
//! the shared core types they reference, then Pi's own docs at the same version.
//! Where the pinned source and the recorded fixtures disagree, the fixtures - real
//! output of the pinned binary - win, and the difference is noted on the type.
//!
//! Conventions taken from pi:
//!
//! * enum tags and values are snake_case (`get_state`, `tool_execution_start`);
//! * payload field names are camelCase (`modelId`, `assistantMessageEvent`);
//! * a field pi marks optional is omitted from the wire, never `null`;
//! * a field pi marks `| null` is written as `null`.
//!
//! Payloads whose TS type is a provider union (a model's `compat`), an
//! extension-defined bag (`details`, `data`) or a redaction record
//! (`diagnostics`) are mirrored as [`serde_json::Value`] so that no shape is
//! invented here and protocol additions stay lossless.

mod command;
mod data;
mod event;
mod extension;
mod message;
mod misc;
mod model;
mod response;
mod server;
mod session;
mod session_entry;

pub use command::{Command, CommandKind, QueueMode, StreamingBehavior};
pub use data::{
    AvailableModelsData, AvailableThinkingLevelsData, ClearQueueData, CloneData, CommandsData, CycleModelData,
    CycleThinkingLevelData, EntriesData, ExportHtmlData, ForkData, ForkMessagesData, LastAssistantTextData,
    MessagesData, NewSessionData, PromptData, QueuedInputData, SwitchSessionData, TreeData,
};
pub use event::{AssistantMessageEvent, CompactionReason, DoneReason, ErrorReason, Event, SummarizationRetrySource};
pub use extension::{
    ExtensionError, ExtensionErrorTag, ExtensionUiRequest, ExtensionUiRequestKind, ExtensionUiRequestTag,
    ExtensionUiResponse, ExtensionUiResponseTag, NotifyType, WidgetPlacement,
};
pub use message::{
    AgentMessage, AssistantContentPart, AssistantMessage, BashExecutionMessage, BranchSummaryMessage,
    CompactionSummaryMessage, CustomMessage, EditableContent, EditableContentPart, ImageContent, ImagePartType,
    NestedToolCallRecord, NestedToolCallStatus, NestedToolCalls, StopReason, SystemContent, SystemMessage, TextContent,
    TextPartType, ThinkingContent, ThinkingPartType, ToolCall, ToolCallPartType, ToolResultContentPart,
    ToolResultMessage, UserContent, UserContentPart,
};
pub use misc::{
    BashResult, CompactionResult, ContextUsage, ForkMessage, PromptDisposition, QueuedInputDisposition, SessionStats,
    SessionTokens, SlashCommand, SlashCommandSource, SourceInfo, SourceOrigin, SourceScope,
};
pub use model::{
    InputModality, Model, ModelCost, ModelCostRates, ModelCostTier, ModelImageInputLimits, ModelImageResizeOptions,
    ModelInputLimits, ModelPromptCache, ModelThinkingLevel, ModelType, ThinkingLevel, ThinkingLevelMap, Usage,
    UsageCost,
};
pub use response::Response;
pub use server::ServerMessage;
pub use session::SessionState;
pub use session_entry::{
    BranchSummaryEntry, CompactionEntry, ContextEditEntry, ContextEditReplacement, CustomEntry, CustomMessageEntry,
    LabelEntry, ModelChangeEntry, SessionEntry, SessionInfoEntry, SessionMessageEntry, SessionTreeNode,
    ThinkingLevelChangeEntry, UsageEntry,
};
