/**
 * The protocol records the frontend reads, named by pi's own published types.
 *
 * The `pi_rpc` crate (https://github.com/kui04/pi_rpc) mirrors `pi --mode rpc`
 * from the pinned release. This file names the same shapes from the frontend's
 * end, so both sides read one source - pi's `rpc-types.ts`, `json-event.ts`,
 * `session-manager.ts` and `packages/ai/src/types.ts` - instead of one side
 * feeding a generated copy to the other.
 *
 * Both packages are dev dependencies. Every import here is a type, which `tsc`
 * erases, so none of their code enters the bundle.
 *
 * Most names below are a bare alias. Two are not, and each says why at its own
 * line. A rename or a shape change in pi fails the build here rather than
 * reaching the screens as a field that is quietly never there.
 */

import type {
    CompactionResult as PiCompactionResult,
    JsonAgentSessionEvent,
    RpcCommand,
    RpcResponse,
    RpcSessionState,
    SessionEntry as PiSessionEntry,
    SessionStats as PiSessionStats,
    SlashCommandSource as PiSlashCommandSource,
} from "@earendil-works/pi-coding-agent";
import type {
    Api,
    AssistantMessage as PiAssistantMessage,
    ImageContent as PiImageContent,
    JsonValue,
    Model as PiModel,
    ModelThinkingLevel as PiModelThinkingLevel,
    ToolCall as PiToolCall,
    ToolResultMessage as PiToolResultMessage,
    Usage as PiUsage,
    UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai";

export type { JsonValue };

/**
 * One record of pi's stdout session stream (`JsonAgentSessionEvent`).
 *
 * This is the JSON projection, not the in-process `AgentSessionEvent`: pi strips
 * the cumulative `partial` snapshot from every `message_update` delta and adds
 * `id` and `toolName` to `toolcall_start`.
 */
export type Event = JsonAgentSessionEvent;

/**
 * The state of the session behind a connection (`RpcSessionState`).
 *
 * The thinking level is widened from pi's own annotation. `RpcSessionState`
 * declares `ThinkingLevel`, which has no `off`, while a real session reports
 * `off` - `get_available_thinking_levels` offers it and `thinking_level_changed`
 * carries it - so the field is a `ModelThinkingLevel`.
 */
export type SessionState = Omit<RpcSessionState, "thinkingLevel"> & {
    thinkingLevel: ModelThinkingLevel;
};

/** One entry of the append-only session file (`SessionEntry`). */
export type SessionEntry = PiSessionEntry;

/** Aggregate statistics of a session (`SessionStats`). */
export type SessionStats = PiSessionStats;

/** Token totals of a session, read out of the statistics pi reports. */
export type SessionTokens = PiSessionStats["tokens"];

/** Result of compacting the conversation (`CompactionResult`). */
export type CompactionResult = PiCompactionResult;

/** What kind of resource provides a slash command (`SlashCommandSource`). */
export type SlashCommandSource = PiSlashCommandSource;

/**
 * A response payload, read out of pi's own response union.
 *
 * `Extract` picks the arm that answers this command, so a command pi renames or
 * changes is a build failure here and not a stale copy. The `success: false` arm
 * never matches: its `command` is a plain `string`.
 */
export type PromptData = Extract<RpcResponse, { command: "prompt" }>["data"];

/** Payload of `clear_queue`. */
export type ClearQueueData = Extract<RpcResponse, { command: "clear_queue" }>["data"];

/** Payload of `get_available_models`. */
export type AvailableModelsData = Extract<RpcResponse, { command: "get_available_models" }>["data"];

/** Payload of `get_available_thinking_levels`. */
export type AvailableThinkingLevelsData = Extract<RpcResponse, { command: "get_available_thinking_levels" }>["data"];

/** Payload of `switch_session`. */
export type SwitchSessionData = Extract<RpcResponse, { command: "switch_session" }>["data"];

/** Payload of `get_entries`. */
export type EntriesData = Extract<RpcResponse, { command: "get_entries" }>["data"];

/** Payload of `get_last_assistant_text`. */
export type LastAssistantTextData = Extract<RpcResponse, { command: "get_last_assistant_text" }>["data"];

/** Payload of `get_commands`. */
export type CommandsData = Extract<RpcResponse, { command: "get_commands" }>["data"];

/** Payload of `bash`. */
export type BashResult = Extract<RpcResponse, { command: "bash" }>["data"];

/** A command invocable through `prompt` with a leading slash (`RpcSlashCommand`). */
export type SlashCommand = CommandsData["commands"][number];

/**
 * How pi queues a message that arrives while the agent is streaming.
 *
 * Pi spells this union inline on the `prompt` command rather than naming it, so
 * it is read out of that arm.
 */
export type StreamingBehavior = NonNullable<Extract<RpcCommand, { type: "prompt" }>["streamingBehavior"]>;

/**
 * One message of a session.
 *
 * Read out of the `get_messages` payload: `AgentMessage` is the coding agent's
 * union of the core roles and the extra ones it adds by declaration merging
 * (`bashExecution`, `custom`, `branchSummary`, `compactionSummary`).
 */
export type AgentMessage = Extract<RpcResponse, { command: "get_messages" }>["data"]["messages"][number];

/** A shell execution kept in the transcript, one of the coding agent's own roles. */
export type BashExecutionMessage = Extract<AgentMessage, { role: "bashExecution" }>;

/** An assistant turn. */
export type AssistantMessage = PiAssistantMessage;

/** Text, reasoning, or a tool call inside an assistant turn. */
export type AssistantContentPart = PiAssistantMessage["content"][number];

/** A streaming delta of one assistant response. */
export type AssistantMessageEvent = Extract<Event, { type: "message_update" }>["assistantMessageEvent"];

/** A user turn. */
export type UserMessage = PiUserMessage;

/** The result of one tool call. */
export type ToolResultMessage = PiToolResultMessage;

/** A tool call the model asked for. */
export type ToolCall = PiToolCall;

/** An image the user attached, as base64 with its MIME type. */
export type ImageContent = PiImageContent;

/** Token usage and cost of one LLM response. */
export type Usage = PiUsage;

/**
 * A model pi can use (`Model`).
 *
 * The API type parameter stays open: the catalog carries models of every
 * provider pi knows, and the frontend reads their display fields, not their
 * provider-specific compat.
 */
export type Model = PiModel<Api>;

/** A pi thinking level including `off` (`ModelThinkingLevel`). */
export type ModelThinkingLevel = PiModelThinkingLevel;
