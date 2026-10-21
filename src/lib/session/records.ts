/**
 * What one record of a session means: how it moves the run, what it draws while the feed is
 * live, which reads it makes stale, and the words a retry says out loud.
 *
 * The table is the single source of that classification: the machine's guards ask it for the
 * run's phase, its `route` action for the reads a record makes stale and the toast it shows,
 * and its `draw` action for the stream write. A test holds the table without a machine and
 * without a TUI.
 */

import type { toast } from "sonner";
import type {
    AgentMessage,
    AssistantMessageEvent,
    Event as SessionRecord,
    JsonValue,
    SessionEntry,
    Usage,
} from "@/lib/rpc-protocol";

/** How a record moves the run. Only begin, write and end close the read authority. */
export type RunReading = "begin" | "write" | "end" | "other";

/**
 * What a record writes while the feed is live and may draw, with the payload the write
 * needs: the drawer narrows on the kind, so no second switch over the record is spent.
 */
export type Drawing =
    | { kind: "liveStart"; message: AgentMessage }
    | { kind: "liveDelta"; event: AssistantMessageEvent; usage: Usage }
    | { kind: "liveEnd"; message: AgentMessage }
    | { kind: "toolStart"; toolCallId: string; args: JsonValue }
    | { kind: "toolUpdate"; toolCallId: string; toolName: string; partialResult: JsonValue }
    | { kind: "toolEnd"; toolCallId: string; toolName: string; result: JsonValue; isError: boolean }
    | { kind: "entry"; entry: SessionEntry }
    | { kind: "queue"; steering: readonly string[]; followUp: readonly string[] }
    | { kind: "bash"; delta: string }
    | { kind: "retrying" }
    | null;

/** Which read a record makes stale. `whole` is the session's own prefix. */
export type ReadTarget = "state" | "stats" | "whole";

/** What a record says out loud. `noticeOf` builds the words from the session's own state. */
export type NoticeSpec =
    | { kind: "auto-retry-start"; errorMessage: string; attempt: number; maxAttempts: number }
    | { kind: "auto-retry-end"; success: boolean; finalError: string }
    | { kind: "summary-scheduled"; errorMessage: string; attempt: number; maxAttempts: number }
    | { kind: "summary-attempt-start"; source: "compaction" | "branchSummary" }
    | { kind: "summary-finished" }
    | { kind: "extension-error"; extensionPath: string; event: string; error: string };

/** A toast, in the words the table owns. */
export type Notice =
    | { kind: "show"; id: string; tone: "warning" | "error"; title: string; description: string }
    | { kind: "dismiss"; id: string };

export interface Reading {
    run: RunReading;
    draws: Drawing;
    invalidates: ReadTarget[];
    /**
     * The response of this run is in the session file now: a stats read written after this
     * moment carries its usage, so the increment may go and this stops waiting for the read.
     */
    settles?: boolean;
    notice?: NoticeSpec;
}

/** The toast of a retry, so a second replaces the first and the one that works can take it away. */
const RETRY_TOAST = "session-retry";

/** The same, for the retry pi runs by itself when a compaction or a branch summary fails. */
const SUMMARY_TOAST = "session-summary-retry";

/** The same, for an extension handler that threw while it answered an event. */
const EXTENSION_TOAST = "session-extension-error";

/** What a record is, for the machine. */
export function reading(record: SessionRecord): Reading {
    switch (record.type) {
        case "agent_start":
            return { run: "begin", draws: null, invalidates: [] };
        case "agent_end":
            return record.willRetry
                ? { run: "other", draws: { kind: "retrying" }, invalidates: [] }
                : { run: "end", draws: null, invalidates: [] };
        case "agent_settled":
            return { run: "end", draws: null, invalidates: ["whole"], settles: true };
        case "turn_start":
            return { run: "other", draws: null, invalidates: [] };
        case "turn_end":
            return { run: "other", draws: null, invalidates: ["stats"] };
        case "message_start":
            return {
                run: record.message.role === "user" ? "begin" : record.message.role === "assistant" ? "write" : "other",
                draws: { kind: "liveStart", message: record.message },
                invalidates: [],
            };
        case "message_update":
            return {
                run: "other",
                draws: {
                    kind: "liveDelta",
                    event: record.assistantMessageEvent,
                    usage: record.usage,
                },
                invalidates: [],
            };
        case "message_end":
            // A run reports its cost while it streams: the read is behind it either way.
            return { run: "other", draws: { kind: "liveEnd", message: record.message }, invalidates: ["stats"] };
        case "tool_execution_start":
            // A nested call (one that a tool made) is drawn inside its parent's card, so the
            // run does not open a call of its own.
            return {
                run: "other",
                draws:
                    record.parentToolCallId === undefined
                        ? { kind: "toolStart", toolCallId: record.toolCallId, args: record.args }
                        : null,
                invalidates: [],
            };
        case "tool_execution_update":
            return {
                run: "other",
                draws: {
                    kind: "toolUpdate",
                    toolCallId: record.toolCallId,
                    toolName: record.toolName,
                    partialResult: record.partialResult,
                },
                invalidates: [],
            };
        case "tool_execution_end":
            return {
                run: "other",
                draws: {
                    kind: "toolEnd",
                    toolCallId: record.toolCallId,
                    toolName: record.toolName,
                    result: record.result,
                    isError: record.isError,
                },
                invalidates: [],
            };
        case "queue_update":
            return {
                run: "other",
                draws: { kind: "queue", steering: record.steering, followUp: record.followUp },
                invalidates: [],
            };
        case "entry_appended":
            return { run: "other", draws: { kind: "entry", entry: record.entry }, invalidates: [] };
        case "session_info_changed":
        case "thinking_level_changed":
            // Both are part of the state of a session, and the pickers read it from there.
            return { run: "other", draws: null, invalidates: ["state"] };
        case "compaction_start":
            return { run: "other", draws: null, invalidates: [] };
        case "compaction_end":
            // The summary is an entry like any other, and no record carries every one of
            // them: the fold of the snapshot is what shows it.
            return { run: "other", draws: null, invalidates: ["whole"] };
        case "bash_execution_update":
            return { run: "other", draws: { kind: "bash", delta: record.delta }, invalidates: [] };
        case "auto_retry_start":
            return {
                run: "other",
                draws: null,
                invalidates: [],
                notice: {
                    kind: "auto-retry-start",
                    errorMessage: record.errorMessage,
                    attempt: record.attempt,
                    maxAttempts: record.maxAttempts,
                },
            };
        case "auto_retry_end":
            return {
                run: "other",
                draws: null,
                invalidates: [],
                notice: {
                    kind: "auto-retry-end",
                    success: record.success,
                    finalError: record.finalError ?? "Unknown error",
                },
            };
        case "summarization_retry_scheduled":
            return {
                run: "other",
                draws: null,
                invalidates: [],
                notice: {
                    kind: "summary-scheduled",
                    errorMessage: record.errorMessage,
                    attempt: record.attempt,
                    maxAttempts: record.maxAttempts,
                },
            };
        case "summarization_retry_attempt_start":
            return {
                run: "other",
                draws: null,
                invalidates: [],
                notice: { kind: "summary-attempt-start", source: record.source },
            };
        case "summarization_retry_finished":
            return { run: "other", draws: null, invalidates: [], notice: { kind: "summary-finished" } };
        case "extension_error":
            // RPC-only: `rpc-protocol.ts` names the record by hand, because pi's own JSON
            // union does not carry it.
            return {
                run: "other",
                draws: null,
                invalidates: [],
                notice: {
                    kind: "extension-error",
                    extensionPath: record.extensionPath,
                    event: record.event,
                    error: record.error,
                },
            };
        default:
            // Everything else belongs to a milestone that shows it: the queue modes, the run's
            // own progress, the context edits.
            return { run: "other", draws: null, invalidates: [] };
    }
}

/** The toast of a spec, in the session's own words ("attempt 2 of 4" needs the machine's state). */
export function noticeOf(spec: NoticeSpec, summary: { attempt: number; maxAttempts: number } | null): Notice | null {
    switch (spec.kind) {
        case "auto-retry-start":
            return {
                kind: "show",
                id: RETRY_TOAST,
                tone: "warning",
                title: "Pi is retrying the request",
                description: `${spec.errorMessage} - attempt ${spec.attempt} of ${spec.maxAttempts}`,
            };
        case "auto-retry-end":
            return spec.success
                ? { kind: "dismiss", id: RETRY_TOAST }
                : {
                      kind: "show",
                      id: RETRY_TOAST,
                      tone: "error",
                      title: "Pi gave up on the request",
                      description: spec.finalError,
                  };
        case "summary-scheduled":
            return {
                kind: "show",
                id: SUMMARY_TOAST,
                tone: "warning",
                title: "Pi is retrying the summary",
                description: `${spec.errorMessage} - attempt ${spec.attempt} of ${spec.maxAttempts}`,
            };
        case "summary-attempt-start": {
            // The attempt that runs now says what pi works on: a compaction of the context,
            // or a summary of a branch.
            const what = spec.source === "branchSummary" ? "Writing a branch summary" : "Compacting the context";
            return {
                kind: "show",
                id: SUMMARY_TOAST,
                tone: "warning",
                title: "Pi is retrying the summary",
                description: summary === null ? what : `${what} - attempt ${summary.attempt} of ${summary.maxAttempts}`,
            };
        }
        case "summary-finished":
            return { kind: "dismiss", id: SUMMARY_TOAST };
        case "extension-error":
            return {
                kind: "show",
                id: EXTENSION_TOAST,
                tone: "warning",
                title: "An extension failed",
                description: `${spec.extensionPath} (${spec.event}): ${spec.error}`,
            };
    }
}

/** Says a notice with the toast of the app. */
export function toastNotice(notice: Notice, say: typeof toast): void {
    if (notice.kind === "dismiss") {
        say.dismiss(notice.id);
    } else if (notice.tone === "error") {
        say.error(notice.title, { id: notice.id, description: notice.description });
    } else {
        say.warning(notice.title, { id: notice.id, description: notice.description });
    }
}
