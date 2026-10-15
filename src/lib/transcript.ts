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
} from "@/lib/rpc-protocol";
import type { LiveCall } from "@/lib/stream";
import { humanize, linesOf, resultText } from "@/lib/text";

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
function sessionPath(store: TranscriptEntries, leafId: string | null): SessionEntry[] {
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
function contextEntries(store: TranscriptEntries, leafId: string | null): SessionEntry[] {
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
          kind: "compaction";
          id: string;
          /** Context size the compaction cut from, for the header line. */
          tokensBefore: number;
          /** The whole summary: the header never excerpts it, the body opens it. */
          body: string;
      }
    | {
          kind: "branch_summary";
          id: string;
          /** The whole summary, as with a compaction. */
          body: string;
      }
    | {
          kind: "skill";
          id: string;
          /**
           * The whole content when it is one line, else nothing: the header of
           * a longer skill is the word alone, never the first line of its body.
           */
          summary: string;
          /** The whole of it, when that is more than the one line. */
          body: string | null;
      }
    | {
          kind: "custom_message";
          id: string;
          /** The extension's own type, e.g. `skill`. */
          customType: string;
          /** The word the header leads with, e.g. `Skill`. */
          label: string;
          /** As with a skill: the whole content, or nothing when it opens. */
          summary: string;
          /** The whole of it, when that is more than the one line. */
          body: string | null;
      };

export function transcriptRows(
    store: TranscriptEntries,
    leafId: string | null,
    /**
     * The name a row renders under, for an entry that took over a message a run had
     * already drawn (`lib/transcript-merge.ts`).
     */
    rowIds?: Map<string, string>,
): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    // Pi keeps a call pending until its result arrives, whichever entries come in
    // between, so the map is cleared only at an assistant message.
    const open = new Map<string, Extract<TranscriptRow, { kind: "assistant" }>>();

    for (const entry of contextEntries(store, leafId)) {
        switch (entry.type) {
            case "message": {
                pushMessage(rows, entry.id, entry.message, rowIds, open);
                break;
            }
            // Bookkeeping the header reads live: a switch of model or level
            // shows in the session's own slots, never as a row.
            case "thinking_level_change":
                break;
            case "model_change":
                break;
            // Model-attributed use outside assistant messages: the usage
            // popover reads it through `get_session_stats`, never as a row.
            case "usage":
                break;
            case "compaction":
                rows.push({ kind: "compaction", id: entry.id, tokensBefore: entry.tokensBefore, body: entry.summary });
                break;
            case "branch_summary":
                if (entry.summary) rows.push({ kind: "branch_summary", id: entry.id, body: entry.summary });
                break;
            // Extension state outside the conversation: never displayed, unlike
            // a `custom_message`, which is an extension's words in it.
            case "custom":
                break;
            case "custom_message":
                if (entry.display) pushCustom(rows, entry.id, entry.customType, partsText(entry.content));
                break;
            // A branch-local edit of one earlier entry: the transcript keeps
            // the words pi wrote, as pi's own transcript does.
            case "context_edit":
                break;
            // A bookmark on one entry for the tree navigator: the list draws
            // no labels, so neither does the transcript.
            case "label":
                break;
            // Session metadata such as the display name: the bar reads it
            // through `get_state`, never as a row.
            case "session_info":
                break;
            default: {
                // Wire-future kinds degrade to nothing: `pi_rpc` keeps an
                // unknown record raw, and a pi newer than this build may send
                // kinds outside the typed union. The never below still fails
                // the build when the *typed* union grows a member.
                const unhandled: never = entry;
                void unhandled;
                break;
            }
        }
    }

    return rows;
}

/**
 * One message entry as rows. Every role is named: a role pi adds is a
 * compile error here, not a row that silently never arrives.
 */
function pushMessage(
    rows: TranscriptRow[],
    id: string,
    message: Extract<SessionEntry, { type: "message" }>["message"],
    rowIds: Map<string, string> | undefined,
    open: Map<string, Extract<TranscriptRow, { kind: "assistant" }>>,
): void {
    switch (message.role) {
        case "system":
            // A system message draws nothing: the fold already dropped the
            // ones a compaction summarized, and the rest are pi's context.
            break;
        case "user":
            rows.push({ kind: "user", id: rowIds?.get(id) ?? id, message });
            break;
        case "assistant": {
            open.clear();
            const row: Extract<TranscriptRow, { kind: "assistant" }> = {
                kind: "assistant",
                id: rowIds?.get(id) ?? id,
                message,
                results: new Map(),
            };
            rows.push(row);
            for (const part of message.content) {
                if (part.type === "toolCall") open.set(part.id, row);
            }
            break;
        }
        case "toolResult": {
            const row = open.get(message.toolCallId);
            if (row) {
                row.results.set(message.toolCallId, message);
                open.delete(message.toolCallId);
            }
            break;
        }
        case "bashExecution":
            rows.push({ kind: "bash", id, message });
            break;
        case "custom":
            if (message.display) pushCustom(rows, id, message.customType, partsText(message.content));
            break;
        // The legacy shapes of the two summaries, kept for sessions pi
        // wrote before they became entries: they read exactly like them.
        case "branchSummary":
            rows.push({ kind: "branch_summary", id, body: message.summary });
            break;
        case "compactionSummary":
            rows.push({ kind: "compaction", id, tokensBefore: message.tokensBefore, body: message.summary });
            break;
        default: {
            // Wire-future roles degrade to nothing, as with entry kinds.
            const unhandled: never = message;
            void unhandled;
            break;
        }
    }
}

/**
 * An extension's words as the row of their kind: `skill` is the one
 * custom type pie knows, and it reads as its own row; every other type
 * reads under the word its extension gave it.
 */
function pushCustom(rows: TranscriptRow[], id: string, customType: string, text: string): void {
    // A one-line text reads whole on its row; a longer one opens instead, and
    // its header stays bare - never the first line of the body.
    const single = linesOf(text).length <= 1;
    if (customType === "skill") {
        rows.push({ kind: "skill", id, summary: single ? text : "", body: single ? null : text });
        return;
    }
    rows.push({
        kind: "custom_message",
        id,
        customType,
        label: humanize(customType),
        summary: single ? text : "",
        body: single ? null : text,
    });
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

/** The text of content that may be a bare string or parts: its text parts. */
function partsText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === "string") return content;
    return resultText(content);
}
