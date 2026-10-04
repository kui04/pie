/**
 * Payload types for the records the bridge hands React.
 *
 * This file describes *shapes*, nothing else: no parser, no framing, no
 * degradation — those belong to Rust. `src-tauri/src/pi_rpc` mirrors the
 * pinned pi checkout, the app layer normalizes what crosses
 * `src/lib/bridge.ts`, and the types here are derived from that mirror. Keep
 * them in sync when the pin or the bridge payloads change; the wire is never
 * interpreted on this side of the boundary.
 *
 * Field names are pi's: camelCase payloads, snake_case tags, optional fields
 * omitted (never `null`), nullable fields written as `null`. Extension bags
 * (`details`, `data`, `compat`) stay `unknown`.
 *
 * The recorded corpus in `src-tauri/tests/fixtures/` is decoded and asserted
 * by `src-tauri/tests/conformance.rs`; nothing here parses a wire record.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Pi thinking level including `off` (`ModelThinkingLevel`). */
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Pi thinking level without `off` (`ThinkingLevel`). */
export type ThinkingLevel = Exclude<ModelThinkingLevel, "off">;

/** Why an assistant response stopped (`StopReason`). */
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/** Categories of content a model accepts (`InputModality`). */
export type InputModality = "text" | "image";

/** How pi queues a message that arrives while the agent is streaming. */
export type StreamingBehavior = "steer" | "followUp";

/** Queue drain mode for steering and follow-up messages. */
export type QueueMode = "all" | "one-at-a-time";

/** How pi dispatched an accepted prompt (`PromptDisposition`). */
export type PromptDisposition = "started" | "queued" | "handled";

/** How pi dispatched queued input (`QueuedInputDisposition`). */
export type QueuedInputDisposition = "queued" | "handled";

/** What kind of thing provides a slash command. */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/** Where a resource comes from (`SourceScope`). */
export type SourceScope = "user" | "project" | "temporary";

/** How a resource was resolved (`SourceOrigin`). */
export type SourceOrigin = "package" | "top-level";

/** Severity of an extension notification. */
export type NotifyType = "info" | "warning" | "error";

/** Where an extension widget is placed relative to the editor. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Why pi compacted the conversation. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** Why an assistant response finished normally. */
export type DoneReason = "stop" | "length" | "toolUse" | "deferred";

/** Why an assistant response failed. */
export type ErrorReason = "aborted" | "error";

/** Outcome of a nested tool call. */
export type NestedToolCallStatus = "ok" | "error" | "unfinished";

// ---------------------------------------------------------------------------
// Models and usage
// ---------------------------------------------------------------------------

/** Per-million-token prices (`ModelCostRates`). */
export interface ModelCostRates {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** A price tier that applies above a token count (`ModelCostTier`). */
export interface ModelCostTier extends ModelCostRates {
    inputTokensAbove: number;
}

/** Cost breakdown of a model (`ModelCost`). */
export interface ModelCost extends ModelCostRates {
    tiers?: ModelCostTier[];
}

/** Best-effort prompt cache lifetime in seconds per retention tier. */
export interface ModelPromptCache {
    short?: number;
    long?: number;
}

/** Image limits of a model (`ModelImageInputLimits`). */
export interface ModelImageInputLimits {
    resize?: Record<string, unknown>;
    maxPerMessage?: number;
    maxPerRequest?: number;
}

/** Input limits of a model (`ModelInputLimits`). */
export interface ModelInputLimits {
    maxRequestBytes?: number;
    images?: ModelImageInputLimits;
}

/**
 * Pi thinking level to provider value mapping (`ThinkingLevelMap`): an absent
 * key means "use the provider default", `null` means "unsupported", a string is
 * the provider's own value.
 */
export interface ThinkingLevelMap {
    off?: string | null;
    minimal?: string | null;
    low?: string | null;
    medium?: string | null;
    high?: string | null;
    xhigh?: string | null;
    max?: string | null;
}

/** A chat model as pi reports it (`Model`). */
export interface Model {
    id: string;
    name: string;
    api: string;
    provider: string;
    baseUrl: string;
    input: InputModality[];
    inputLimits?: ModelInputLimits;
    cost: ModelCost;
    headers?: Record<string, string>;
    type?: "chat";
    reasoning: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    promptCache?: ModelPromptCache;
    contextWindow: number;
    maxTokens: number;
    samplingParams?: unknown;
    compat?: unknown;
}

/** Cost breakdown of one usage record (`Usage["cost"]`). */
export interface UsageCost {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

/** Token usage of one LLM response (`Usage`). */
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: UsageCost;
}

// ---------------------------------------------------------------------------
// Messages and content parts
// ---------------------------------------------------------------------------

/** Plain text content part. */
export interface TextContent {
    type: "text";
    text: string;
    textSignature?: string;
}

/** Reasoning text content part. */
export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
}

/** Base64 image content part. */
export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
}

/** A tool call requested by the assistant (tag is `toolCall`). */
export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
    namespace?: string;
}

/** A content part of a user message. */
export type UserContentPart = TextContent | ImageContent;

/** A content part of an assistant message. */
export type AssistantContentPart = TextContent | ThinkingContent | ToolCall;

/** A content part of a tool result. */
export type ToolResultContentPart = TextContent | ImageContent;

/** Any content part a context edit may carry. */
export type EditableContentPart = TextContent | ThinkingContent | ImageContent | ToolCall;

/** A user message body: a bare string or text/image parts. */
export type UserContent = string | UserContentPart[];

/** Content an append-only context edit may replace. */
export type EditableContent = string | EditableContentPart[];

/** A system message body: a bare string or text parts. */
export type SystemContent = string | TextContent[];

/** Instructions replayed into the context (`SystemMessage`). */
export interface SystemMessage {
    role: "system";
    content: SystemContent;
    sections?: Record<string, string | null>;
    toolsAdded?: unknown;
    toolsRemoved?: unknown;
    timestamp: number;
}

/** A user turn (`UserMessage`). */
export interface UserMessage {
    role: "user";
    content: UserContent;
    timestamp: number;
}

/** An assistant turn (`AssistantMessage`). */
export interface AssistantMessage {
    role: "assistant";
    content: AssistantContentPart[];
    api: string;
    provider: string;
    model: string;
    responseModel?: string;
    responseId?: string;
    providerThinkingLevel?: string;
    thinkingLevel?: ModelThinkingLevel;
    diagnostics?: unknown;
    usage: Usage;
    stopReason: StopReason;
    deferred?: unknown;
    errorMessage?: string;
    rawStopReason?: string;
    endTurn?: boolean;
    timestamp: number;
}

/** One nested tool call a tool made while it ran. */
export interface NestedToolCallRecord {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    argumentsBytes?: number;
    status: NestedToolCallStatus;
    durationMs?: number;
    error?: string;
}

/** Bounded record of the nested calls a tool made. */
export interface NestedToolCalls {
    calls: NestedToolCallRecord[];
    complete: boolean;
}

/** The result of one tool call (`ToolResultMessage`). */
export interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: ToolResultContentPart[];
    details?: unknown;
    usage?: Usage;
    nestedCalls?: NestedToolCalls;
    isError: boolean;
    timestamp: number;
}

/** A shell execution kept in the transcript (`BashExecutionMessage`). */
export interface BashExecutionMessage {
    role: "bashExecution";
    command: string;
    output: string;
    exitCode?: number;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
    timestamp: number;
    excludeFromContext?: boolean;
}

/** A message an extension injected into the conversation (`CustomMessage`). */
export interface CustomMessage {
    role: "custom";
    customType: string;
    content: EditableContent;
    display: boolean;
    details?: unknown;
    timestamp: number;
}

/** A summary of a branch that was abandoned (`BranchSummaryMessage`). */
export interface BranchSummaryMessage {
    role: "branchSummary";
    summary: string;
    fromId: string | null;
    timestamp: number;
}

/** A summary that replaced compacted history (`CompactionSummaryMessage`). */
export interface CompactionSummaryMessage {
    role: "compactionSummary";
    summary: string;
    tokensBefore: number;
    timestamp: number;
}

/**
 * One message in a session (`AgentMessage`), discriminated by `role`. An
 * extension-added role outside this union arrives as an unknown record, never a
 * broken parse.
 */
export type AgentMessage =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | ToolResultMessage
    | BashExecutionMessage
    | CustomMessage
    | BranchSummaryMessage
    | CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Session entries
// ---------------------------------------------------------------------------

interface SessionEntryBase {
    id: string;
    parentId: string | null;
    timestamp: string;
}

/** A `message` entry: one conversation message. */
export interface SessionMessageEntry extends SessionEntryBase {
    type: "message";
    message: AgentMessage;
}

/** A `thinking_level_change` entry. */
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
    type: "thinking_level_change";
    thinkingLevel: string;
}

/** A `model_change` entry. */
export interface ModelChangeEntry extends SessionEntryBase {
    type: "model_change";
    provider: string;
    modelId: string;
}

/** A `usage` entry: usage outside the main conversation. */
export interface UsageEntryRecord extends SessionEntryBase {
    type: "usage";
    kind: string;
    provider: string;
    model: string;
    usage: Usage;
    note?: string;
}

/** A `compaction` entry: a summary that replaced earlier history. */
export interface CompactionEntryRecord extends SessionEntryBase {
    type: "compaction";
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
    usage?: Usage;
    fromHook?: boolean;
    systemMessage?: SystemMessage;
}

/** A `branch_summary` entry. */
export interface BranchSummaryEntryRecord extends SessionEntryBase {
    type: "branch_summary";
    fromId: string;
    summary: string;
    details?: unknown;
    usage?: Usage;
    fromHook?: boolean;
}

/** A `custom` entry: extension state, never sent to the model. */
export interface CustomEntryRecord extends SessionEntryBase {
    type: "custom";
    customType: string;
    data?: unknown;
}

/** A `custom_message` entry: extension content that does enter the context. */
export interface CustomMessageEntryRecord extends SessionEntryBase {
    type: "custom_message";
    customType: string;
    content: EditableContent;
    details?: unknown;
    display: boolean;
}

/** A `context_edit` entry: an append-only change to earlier context. */
export interface ContextEditEntryRecord extends SessionEntryBase {
    type: "context_edit";
    targetId: string;
    replacement: { content: EditableContent } | null;
}

/** A `label` entry: a user-defined marker on another entry. */
export interface LabelEntryRecord extends SessionEntryBase {
    type: "label";
    targetId: string;
    label?: string;
}

/** A `session_info` entry: session metadata such as a display name. */
export interface SessionInfoEntryRecord extends SessionEntryBase {
    type: "session_info";
    name?: string;
}

/** One entry of the append-only session tree (`SessionEntry`). */
export type SessionEntry =
    | SessionMessageEntry
    | ThinkingLevelChangeEntry
    | ModelChangeEntry
    | UsageEntryRecord
    | CompactionEntryRecord
    | BranchSummaryEntryRecord
    | CustomEntryRecord
    | CustomMessageEntryRecord
    | ContextEditEntryRecord
    | LabelEntryRecord
    | SessionInfoEntryRecord;

/** One node of the session tree (`SessionTreeNode`). */
export interface SessionTreeNode {
    entry: SessionEntry;
    children: SessionTreeNode[];
    label?: string;
    labelTimestamp?: string;
}

// ---------------------------------------------------------------------------
// Session state and statistics
// ---------------------------------------------------------------------------

/** The state of the session behind a connection (`RpcSessionState`). */
export interface SessionState {
    model?: Model;
    thinkingLevel: ModelThinkingLevel;
    isStreaming: boolean;
    isCompacting: boolean;
    steeringMode: QueueMode;
    followUpMode: QueueMode;
    sessionFile?: string;
    sessionId: string;
    sessionName?: string;
    autoCompactionEnabled: boolean;
    messageCount: number;
    pendingMessageCount: number;
}

/** Token totals of a session (`SessionStats["tokens"]`). */
export interface SessionTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

/** How full the context window is (`ContextUsage`). */
export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

/** Aggregate statistics of a session (`SessionStats`). */
export interface SessionStats {
    sessionFile?: string;
    sessionId: string;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: SessionTokens;
    cost: number;
    contextUsage?: ContextUsage;
}

// ---------------------------------------------------------------------------
// Commands and results
// ---------------------------------------------------------------------------

/** Metadata of the resource that owns a command (`SourceInfo`). */
export interface SourceInfo {
    path: string;
    source: string;
    scope: SourceScope;
    origin: SourceOrigin;
    baseDir?: string;
}

/** A command that can be invoked through a prompt (`RpcSlashCommand`). */
export interface SlashCommand {
    name: string;
    description?: string;
    source: SlashCommandSource;
    sourceInfo: SourceInfo;
}

/** Result of running a shell command through pi (`BashResult`). */
export interface BashResult {
    output: string;
    exitCode?: number;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
}

/** Result of compacting the conversation (`CompactionResult`). */
export interface CompactionResult {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
    usage?: Usage;
    details?: unknown;
}

/** One entry offered for forking (`get_fork_messages`). */
export interface ForkMessage {
    entryId: string;
    text: string;
}

/** A command record for stdin, mirroring `RpcCommand`. */
export type CommandKind =
    | { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: StreamingBehavior }
    | { type: "steer"; message: string; images?: ImageContent[] }
    | { type: "follow_up"; message: string; images?: ImageContent[] }
    | { type: "abort" }
    | { type: "clear_queue" }
    | { type: "new_session"; parentSession?: string }
    | { type: "get_state" }
    | { type: "set_model"; provider: string; modelId: string }
    | { type: "cycle_model" }
    | { type: "get_available_models" }
    | { type: "set_thinking_level"; level: ModelThinkingLevel }
    | { type: "cycle_thinking_level" }
    | { type: "get_available_thinking_levels" }
    | { type: "set_steering_mode"; mode: QueueMode }
    | { type: "set_follow_up_mode"; mode: QueueMode }
    | { type: "compact"; customInstructions?: string }
    | { type: "set_auto_compaction"; enabled: boolean }
    | { type: "set_auto_retry"; enabled: boolean }
    | { type: "abort_retry" }
    | { type: "bash"; command: string; excludeFromContext?: boolean }
    | { type: "abort_bash" }
    | { type: "get_session_stats" }
    | { type: "export_html"; outputPath?: string }
    | { type: "switch_session"; sessionPath: string }
    | { type: "fork"; entryId: string }
    | { type: "clone" }
    | { type: "get_fork_messages" }
    | { type: "get_entries"; since?: string }
    | { type: "get_tree" }
    | { type: "get_last_assistant_text" }
    | { type: "set_session_name"; name: string }
    | { type: "get_messages" }
    | { type: "get_commands" };

/** A command with pi's optional correlation id. */
export type Command = CommandKind & { id?: string };

/** Payload of `prompt`. */
export interface PromptData {
    disposition: PromptDisposition;
}

/** Payload of `steer` and `follow_up`. */
export interface QueuedInputData {
    disposition: QueuedInputDisposition;
}

/** Payload of `clear_queue`. */
export interface ClearQueueData {
    steering: string[];
    followUp: string[];
}

/** Payload of `new_session`. */
export interface NewSessionData {
    cancelled: boolean;
}

/** Payload of `cycle_model`. */
export interface CycleModelData {
    model: Model;
    thinkingLevel: ModelThinkingLevel;
    isScoped: boolean;
}

/** Payload of `get_available_models`. */
export interface AvailableModelsData {
    models: Model[];
}

/** Payload of `cycle_thinking_level`. */
export interface CycleThinkingLevelData {
    level: ModelThinkingLevel;
}

/** Payload of `get_available_thinking_levels`. */
export interface AvailableThinkingLevelsData {
    levels: ModelThinkingLevel[];
}

/** Payload of `export_html`. */
export interface ExportHtmlData {
    path: string;
}

/** Payload of `switch_session` and `new_session`. */
export interface SwitchSessionData {
    cancelled: boolean;
}

/** Payload of `fork`. */
export interface ForkData {
    text: string;
    cancelled: boolean;
}

/** Payload of `clone`. */
export interface CloneData {
    cancelled: boolean;
}

/** Payload of `get_fork_messages`. */
export interface ForkMessagesData {
    messages: ForkMessage[];
}

/** Payload of `get_entries`. */
export interface EntriesData {
    entries: SessionEntry[];
    leafId: string | null;
}

/** Payload of `get_tree`. */
export interface TreeData {
    tree: SessionTreeNode[];
    leafId: string | null;
}

/** Payload of `get_last_assistant_text`. */
export interface LastAssistantTextData {
    text?: string;
}

/** Payload of `get_messages`. */
export interface MessagesData {
    messages: AgentMessage[];
}

/** Payload of `get_commands`. */
export interface CommandsData {
    commands: SlashCommand[];
}

/** A response to one command (`RpcResponse`). */
export interface Response {
    id?: string;
    command: string;
    success: boolean;
    data?: unknown;
    error?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A streaming update inside a `message_update` event. */
export type AssistantMessageEvent =
    | { type: "start" }
    | { type: "text_start"; contentIndex: number }
    | { type: "text_delta"; contentIndex: number; delta: string }
    | { type: "text_end"; contentIndex: number; content: string }
    | { type: "thinking_start"; contentIndex: number }
    | { type: "thinking_delta"; contentIndex: number; delta: string }
    | { type: "thinking_end"; contentIndex: number; content: string }
    | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
    | { type: "toolcall_delta"; contentIndex: number; delta: string }
    | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
    | { type: "done"; reason: DoneReason; message: AssistantMessage }
    | { type: "error"; reason: ErrorReason; error: AssistantMessage };

/** What produced a summarization retry. */
export type SummarizationRetrySource = { source: "branchSummary" } | { source: "compaction"; reason: CompactionReason };

/** One event from pi's session event stream. */
export type Event =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
    | { type: "turn_start" }
    | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
    | { type: "message_start"; message: AgentMessage }
    | { type: "message_update"; usage: Usage; assistantMessageEvent: AssistantMessageEvent }
    | { type: "message_end"; message: AgentMessage }
    | {
          type: "tool_execution_start";
          toolCallId: string;
          toolName: string;
          args: unknown;
          parentToolCallId?: string;
      }
    | {
          type: "tool_execution_update";
          toolCallId: string;
          toolName: string;
          args: unknown;
          partialResult: unknown;
          parentToolCallId?: string;
      }
    | {
          type: "tool_execution_end";
          toolCallId: string;
          toolName: string;
          result: unknown;
          isError: boolean;
          parentToolCallId?: string;
      }
    | { type: "agent_settled" }
    | { type: "queue_update"; steering: string[]; followUp: string[] }
    | { type: "compaction_start"; reason: CompactionReason }
    | {
          type: "compaction_end";
          reason: CompactionReason;
          result: CompactionResult | null;
          aborted: boolean;
          willRetry: boolean;
          errorMessage?: string;
      }
    | { type: "entry_appended"; entry: SessionEntry }
    | { type: "session_info_changed"; name?: string }
    | { type: "thinking_level_changed"; level: ModelThinkingLevel }
    | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
    | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
    | {
          type: "summarization_retry_scheduled";
          attempt: number;
          maxAttempts: number;
          delayMs: number;
          errorMessage: string;
      }
    | ({ type: "summarization_retry_attempt_start" } & SummarizationRetrySource)
    | { type: "summarization_retry_finished" }
    | { type: "bash_execution_update"; id?: string; delta: string };

// ---------------------------------------------------------------------------
// Extension UI
// ---------------------------------------------------------------------------

/** The body of an `extension_ui_request`, tagged on `method`. */
export type ExtensionUiRequestKind =
    | { method: "select"; title: string; options: string[]; timeout?: number }
    | { method: "confirm"; title: string; message: string; timeout?: number }
    | { method: "input"; title: string; placeholder?: string; timeout?: number }
    | { method: "editor"; title: string; prefill?: string }
    | { method: "notify"; message: string; notifyType?: NotifyType }
    | { method: "setStatus"; statusKey: string; statusText?: string }
    | {
          method: "setWidget";
          widgetKey: string;
          widgetLines?: string[];
          widgetPlacement?: WidgetPlacement;
      }
    | { method: "setTitle"; title: string }
    | { method: "set_editor_text"; text: string };

/** A dialog or status update pi sent on stdout. */
export type ExtensionUiRequest = { type: "extension_ui_request"; id: string } & ExtensionUiRequestKind;

/** An answer to an `ExtensionUiRequest`: a value, a confirmation, or a cancel. */
export type ExtensionUiResponse =
    | { type: "extension_ui_response"; id: string; value: string }
    | { type: "extension_ui_response"; id: string; confirmed: boolean }
    | { type: "extension_ui_response"; id: string; cancelled: true };

/** An extension handler failure pi reported on stdout. */
export interface ExtensionError {
    type: "extension_error";
    extensionPath: string;
    event: string;
    error: string;
}
