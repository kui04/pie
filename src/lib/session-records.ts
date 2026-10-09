/**
 * Where each record of a session goes: a table the chart calls, so a test feeds it
 * records instead of driving an event bus (`.agents/rules/state.md`).
 *
 * `drawing` is what the chart decided: the rows a record draws are written only where
 * the conversation it belongs to is the one in view. What is not a row - a read gone
 * stale, the words of a retry - applies either way.
 */

import type { QueryKey } from "@tanstack/react-query";
import type { toast } from "sonner";
import type { AgentMessage, AssistantMessageEvent, Event as SessionRecord, SessionEntry, Usage } from "@/lib/protocol";
import type { JsonValue } from "@/lib/protocol/serde_json/JsonValue";
import type { QueuedMessages } from "@/lib/stream";

/** What the records write in the store of the transcript. */
export interface RecordTranscript {
    appendEntry: (entry: SessionEntry) => void;
    setQueue: (queued: QueuedMessages) => void;
    appendBash: (delta: string) => void;
    liveStart: (message: AgentMessage) => void;
    liveDelta: (event: AssistantMessageEvent) => void;
    liveEnd: (message: AgentMessage) => void;
    liveToolStart: (call: { toolCallId: string; args: JsonValue }) => void;
    liveToolUpdate: (call: { toolCallId: string; toolName: string; partialResult: JsonValue }) => void;
    liveToolEnd: (call: { toolCallId: string; toolName: string; result: JsonValue; isError: boolean }) => void;
    liveRetrying: () => void;
    setLiveUsage: (usage: Usage) => void;
}

export interface RecordDeps {
    /** The session the reads and the words belong to. */
    session: string;
    transcript: RecordTranscript;
    /** Asks again for what a record made stale. */
    invalidate: (key: QueryKey) => void;
    /** Says what a retry is doing, and takes the words back. */
    toast: typeof toast;
}

/** The table of one session: it remembers the attempt the last summary retry named. */
export interface RecordTable {
    /** Applies one record. `drawing` says whether the rows it draws may be written. */
    apply: (record: SessionRecord, drawing: boolean) => void;
}

/** The toast of a retry, so a second replaces the first and the one that works can take it away. */
const RETRY_TOAST = "session-retry";

/** The same, for the retry pi runs by itself when a compaction or a branch summary fails. */
const SUMMARY_TOAST = "session-summary-retry";

/** What a summarization retry is working on, and which attempt it is. */
function summarising(
    source: { source: "branchSummary" } | { source: "compaction" },
    at: { attempt: number; maxAttempts: number } | null,
): string {
    const what = source.source === "branchSummary" ? "Writing a branch summary" : "Compacting the context";
    return at === null ? what : `${what} - attempt ${at.attempt} of ${at.maxAttempts}`;
}

export function createRecordTable(deps: RecordDeps): RecordTable {
    const { session, transcript, invalidate, toast } = deps;

    /** The attempt the last scheduled summarization retry named. */
    let summarisingAt: { attempt: number; maxAttempts: number } | null = null;

    const state = () => ["session", session, "state"] as const;
    const stats = () => ["session", session, "stats"] as const;
    const whole = () => ["session", session] as const;

    return {
        apply: (record, drawing) => {
            switch (record.type) {
                case "message_start":
                    if (drawing) transcript.liveStart(record.message);
                    break;
                case "message_update":
                    // The seam held this delta for the frame it belongs to; the usage
                    // of a response is reported with every delta and stands until a read
                    // that holds the response answers.
                    if (drawing) {
                        transcript.liveDelta(record.assistantMessageEvent);
                        transcript.setLiveUsage(record.usage);
                    }
                    break;
                case "message_end":
                    if (drawing) {
                        // The final message is the authority over what the deltas built.
                        transcript.liveEnd(record.message);
                    }
                    // A run reports its cost while it streams: the read is behind it either way.
                    invalidate(stats());
                    break;
                case "tool_execution_start":
                    // A nested call (one that a tool made) is drawn inside its parent's card,
                    // so the run does not open a call of its own.
                    if (drawing && record.parentToolCallId === undefined) {
                        transcript.liveToolStart({ toolCallId: record.toolCallId, args: record.args });
                    }
                    break;
                case "tool_execution_update":
                    if (drawing) {
                        transcript.liveToolUpdate({
                            toolCallId: record.toolCallId,
                            toolName: record.toolName,
                            partialResult: record.partialResult,
                        });
                    }
                    break;
                case "tool_execution_end":
                    if (drawing) {
                        transcript.liveToolEnd({
                            toolCallId: record.toolCallId,
                            toolName: record.toolName,
                            result: record.result,
                            isError: record.isError,
                        });
                    }
                    break;
                case "entry_appended":
                    // An entry that arrives while a switch is on its way may be the tail of
                    // the conversation being left; the read that follows the switch carries
                    // everything the new one holds.
                    if (drawing) transcript.appendEntry(record.entry);
                    break;
                case "session_info_changed":
                case "thinking_level_changed":
                    // Both are part of the state of a session, and the pickers read it from there.
                    invalidate(state());
                    break;
                case "agent_end":
                    // Pi runs the turn again by itself: the failure the run just wrote is
                    // not the end of it, so nothing says so yet.
                    if (drawing && record.willRetry) transcript.liveRetrying();
                    break;
                case "agent_settled":
                    // The run is over and its messages are in the session file now: the read
                    // that follows replaces the rows the run drew with the entries.
                    invalidate(whole());
                    break;
                case "compaction_end":
                    // The summary is an entry like any other, and no record carries it: the
                    // fold of the snapshot is what shows it.
                    invalidate(whole());
                    break;
                case "turn_end":
                    invalidate(stats());
                    break;
                case "queue_update":
                    if (drawing) transcript.setQueue({ steering: record.steering, followUp: record.followUp });
                    break;
                case "bash_execution_update":
                    if (drawing) transcript.appendBash(record.delta);
                    break;
                case "auto_retry_start":
                    toast.warning("Pi is retrying the request", {
                        id: RETRY_TOAST,
                        description: `${record.errorMessage} - attempt ${record.attempt} of ${record.maxAttempts}`,
                    });
                    break;
                case "auto_retry_end":
                    if (record.success) {
                        toast.dismiss(RETRY_TOAST);
                    } else {
                        toast.error("Pi gave up on the request", { id: RETRY_TOAST, description: record.finalError });
                    }
                    break;
                case "summarization_retry_scheduled":
                    summarisingAt = { attempt: record.attempt, maxAttempts: record.maxAttempts };
                    toast.warning("Pi is retrying the summary", {
                        id: SUMMARY_TOAST,
                        description: `${record.errorMessage} - attempt ${record.attempt} of ${record.maxAttempts}`,
                    });
                    break;
                case "summarization_retry_attempt_start":
                    // The attempt that runs now says what pi works on: a compaction of the
                    // context, or a summary of a branch.
                    toast.warning("Pi is retrying the summary", {
                        id: SUMMARY_TOAST,
                        description: summarising(record, summarisingAt),
                    });
                    break;
                case "summarization_retry_finished":
                    summarisingAt = null;
                    toast.dismiss(SUMMARY_TOAST);
                    break;
                default:
                    // Everything else belongs to a milestone that shows it: the queue modes,
                    // the run's own progress, the context edits.
                    break;
            }
        },
    };
}
