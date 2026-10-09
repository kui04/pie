/**
 * The transcript, as the rows a screen renders: the path to the leaf with the last
 * compaction folded in, then the rows below.
 *
 * Two rules of pi's transcript (`renderSessionItems` of `modes/interactive/
 * interactive-mode.ts`) decide what an entry becomes: a tool result renders into
 * the card of the call it answers (matched by `toolCallId`; one whose call was
 * folded away is dropped), and a system message, a bookkeeping entry or a `custom`
 * entry draws nothing. What is left is a row per entry.
 */

import type {
    AssistantMessage,
    BashExecutionMessage,
    SessionEntry,
    ToolResultMessage,
    UserMessage,
} from "@/lib/protocol";
import type { LiveCall } from "@/lib/stream";
import { linesOf, resultText } from "@/lib/text";

/** The entries of a session, in the shape the fold reads. */
export interface TranscriptEntries {
    /** Every entry, by id. */
    entries: Map<string, SessionEntry>;
    /** The ids in the order pi wrote them: the file order of the snapshot. */
    order: string[];
}

/**
 * The path from the root to the leaf, following `parentId`. A `null` leaf is an
 * empty session, so the answer is empty - pi's rule, not "the last entry". A leaf
 * that no entry carries falls back to the last of the file order, and a missing
 * parent ends the walk.
 */
export function sessionPath(store: TranscriptEntries, leafId: string | null): SessionEntry[] {
    if (leafId === null) return [];

    const last = store.order.length > 0 ? store.entries.get(store.order[store.order.length - 1]) : undefined;
    const leaf = (leafId ? store.entries.get(leafId) : undefined) ?? last;
    if (!leaf) return [];

    const path: SessionEntry[] = [];
    let current: SessionEntry | undefined = leaf;
    while (current) {
        path.push(current);
        current = current.parentId ? store.entries.get(current.parentId) : undefined;
    }
    return path.reverse();
}

/**
 * The entries of the transcript: the path with the latest compaction folded in -
 * the compaction stands for what it replaced, the entries from `firstKeptEntryId`
 * on stay (its system messages drop), and everything after it stays.
 */
export function contextEntries(store: TranscriptEntries, leafId: string | null): SessionEntry[] {
    const path = sessionPath(store, leafId);

    let compaction: Extract<SessionEntry, { type: "compaction" }> | undefined;
    for (const entry of path) {
        if (entry.type === "compaction") compaction = entry;
    }
    if (!compaction) return path;

    const at = path.findIndex((entry) => entry.id === compaction.id);
    if (at < 0) return path;

    const context: SessionEntry[] = [compaction];
    let fromFirstKept = false;
    for (let index = 0; index < at; index += 1) {
        const entry = path[index];
        if (entry.id === compaction.firstKeptEntryId) fromFirstKept = true;
        if (fromFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
            context.push(entry);
        }
    }
    context.push(...path.slice(at + 1));
    return context;
}

export type TranscriptRow =
    | { kind: "user"; id: string; message: UserMessage }
    | {
          kind: "assistant";
          id: string;
          message: AssistantMessage;
          /** What the calls of this message answered, by call id. */
          results: Map<string, ToolResultMessage>;
          /**
           * Set while the run still writes this message, with what it streamed for each
           * call; the read that follows the run replaces the row with the entries.
           */
          live?: { calls: Map<string, LiveCall>; retrying: boolean };
      }
    | { kind: "bash"; id: string; message: BashExecutionMessage }
    | {
          kind: "queued";
          id: string;
          /** The words of the message that waits. */
          text: string;
          /** The queue it waits in. */
          queue: "steer" | "followUp";
      }
    | {
          kind: "activity";
          /** The row's own name: there is one of them, and it has no entry behind it. */
          id: "activity";
          /**
           * What the run of this session is doing: `waiting` from the moment a reader
           * sends until the model's first output arrives, `working` from then on - the
           * model writes, or a call it made runs.
           */
          state: "waiting" | "working";
      }
    | {
          kind: "notice";
          id: string;
          /** The bracketed word the header leads with, e.g. `[compaction]`. */
          label: string;
          /** One line of it, for the header. */
          summary: string;
          /** The whole of it, when that is more than the one line. */
          body: string | null;
      };

export function transcriptRows(
    store: TranscriptEntries,
    leafId: string | null,
    /**
     * The name a row renders under, for an entry that took over a message a run had
     * already drawn (`stores/transcript.store.ts`).
     */
    rowIds?: Map<string, string>,
): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    // Pi keeps a call pending until its result arrives, whichever entries come in
    // between, so the map is cleared only at an assistant message.
    let open = new Map<string, Extract<TranscriptRow, { kind: "assistant" }>>();

    for (const entry of contextEntries(store, leafId)) {
        switch (entry.type) {
            case "message": {
                const message = entry.message;
                if (message.role === "user") {
                    rows.push({ kind: "user", id: rowIds?.get(entry.id) ?? entry.id, message });
                } else if (message.role === "assistant") {
                    open = new Map();
                    const row: Extract<TranscriptRow, { kind: "assistant" }> = {
                        kind: "assistant",
                        id: rowIds?.get(entry.id) ?? entry.id,
                        message,
                        results: new Map(),
                    };
                    rows.push(row);
                    for (const part of message.content) {
                        if (part.type === "toolCall") open.set(part.id, row);
                    }
                } else if (message.role === "bashExecution") {
                    rows.push({ kind: "bash", id: entry.id, message });
                } else if (message.role === "toolResult") {
                    const row = open.get(message.toolCallId);
                    if (row) {
                        row.results.set(message.toolCallId, message);
                        open.delete(message.toolCallId);
                    }
                }
                break;
            }
            case "compaction":
                rows.push(notice(entry.id, "[compaction]", entry.summary));
                break;
            case "branch_summary":
                if (entry.summary) rows.push(notice(entry.id, "[branch]", entry.summary));
                break;
            case "custom_message":
                if (entry.display) {
                    rows.push(notice(entry.id, `[${entry.customType}]`, partsText(entry.content)));
                }
                break;
            default:
                break;
        }
    }

    return rows;
}

/**
 * The rows of the messages that pi holds, in the order they were queued: steering
 * first, then follow-ups, which is the order pi drains them.
 *
 * A queued prompt is a transcript row - the chat page hangs it below the working
 * row - so it lives in the same fold as the entries. It is the last thing the
 * reader said, and it scrolls with the thread.
 */
export function queuedRows(queued: { steering: readonly string[]; followUp: readonly string[] }): TranscriptRow[] {
    return [
        ...queued.steering.map((text, index) => ({
            kind: "queued" as const,
            id: `queued-steer-${index}`,
            text,
            queue: "steer" as const,
        })),
        ...queued.followUp.map((text, index) => ({
            kind: "queued" as const,
            id: `queued-follow-${index}`,
            text,
            queue: "followUp" as const,
        })),
    ];
}

/** A notice: the label, its first line, and the whole text when it has more. */
function notice(id: string, label: string, text: string): TranscriptRow {
    const lines = linesOf(text);
    return { kind: "notice", id, label, summary: lines[0] ?? "", body: lines.length > 1 ? text : null };
}

/** The text of content that may be a bare string or parts: its text parts. */
function partsText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === "string") return content;
    return resultText(content);
}
