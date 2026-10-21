/**
 * The transcript as turns: a reader's message, the work it set going, and the answer
 * that work produced.
 *
 * The work of one turn is folded into a single block - the calls it made, the text the
 * model wrote between them, a notice pi left there - and the answer the turn finished
 * on stays outside it, so the fold never hides what a reader came for. A thought is not
 * a row: it is counted, and the fold carries it for the bindings that will show it
 * (`Ctrl+T`, as pi binds it), which is why the count stays in the facts.
 */

import type { AssistantMessage, ToolResultMessage } from "@/lib/rpc-protocol";
import type { LiveCall } from "@/lib/transcript";
import type { TranscriptRow } from "@/lib/transcript";
import { failedCall, presentCall, stopNote, type ToolPresentation } from "@/routes/chat/transcript/presentation";

/** A row the fold leaves where it stands. */
export type FoldEntry = Exclude<TranscriptRow, { kind: "assistant" }>;

/** What the folded heading counts, and the clock it names. */
export interface WorkFacts {
    /** From the reader's message to the model's last word, when it is known. */
    workedMs: number | null;
    /** Calls the model made. */
    calls: number;
    /** Distinct paths the work wrote. */
    files: number;
    /** Calls that failed, so a folded heading can say so. */
    failed: number;
}

export type WorkItem =
    | { kind: "call"; id: string; tool: string; presentation: ToolPresentation }
    | { kind: "text"; id: string; text: string }
    | { kind: "thinking"; id: string; thinking: string; streaming: boolean }
    | { kind: "compaction"; id: string; tokensBefore: number; body: string }
    | { kind: "branch_summary"; id: string; body: string }
    | { kind: "skill"; id: string; summary: string; body: string | null }
    | {
          kind: "custom_message";
          id: string;
          customType: string;
          label: string;
          summary: string;
          body: string | null;
      };

/** The words a settled turn finished on. */
export interface WorkAnswer {
    id: string;
    parts: { id: string; text: string }[];
}

export type FoldSlot =
    | { kind: "entry"; key: string; row: FoldEntry }
    | {
          kind: "work";
          key: string;
          facts: WorkFacts;
          items: WorkItem[];
          answer: WorkAnswer | null;
          note: string | null;
          live: boolean;
      };

/** The tools whose call writes a path, which the heading counts as a file. */
const WRITES = new Set(["edit", "write", "patch", "apply_patch"]);

/** How many rows a live turn keeps before it counts the rest: a phone's worth. */
export const LIVE_ROWS = 7;

interface Open {
    id: string;
    sentAt: number | null;
    items: WorkItem[];
    calls: number;
    files: Set<string>;
    failed: number;
    latest: Extract<TranscriptRow, { kind: "assistant" }>;
    live: boolean;
}

/**
 * The rows of a transcript, as the slots a screen draws: the reader's messages and the
 * answers as rows of their own, and each turn's work as one block.
 */
export function foldTurns(rows: TranscriptRow[]): FoldSlot[] {
    const slots: FoldSlot[] = [];
    let open: Open | null = null;
    let sentAt: number | null = null;

    const flush = () => {
        if (open !== null) slots.push(close(open));
        open = null;
    };

    for (const row of rows) {
        if (row.kind === "assistant") {
            if (open === null) {
                open = {
                    id: row.id,
                    sentAt,
                    items: [],
                    calls: 0,
                    files: new Set(),
                    failed: 0,
                    latest: row,
                    live: false,
                };
            }
            push(open, row);
            continue;
        }

        // A notice pi left inside a run belongs to the work it interrupted.
        // Every kind is named: a row pi adds is a compile error here, not a
        // turn that silently drops it.
        if (row.kind === "compaction" && open !== null) {
            open.items.push({ kind: "compaction", id: row.id, tokensBefore: row.tokensBefore, body: row.body });
            continue;
        }
        if (row.kind === "branch_summary" && open !== null) {
            open.items.push({ kind: "branch_summary", id: row.id, body: row.body });
            continue;
        }
        if (row.kind === "skill" && open !== null) {
            open.items.push({ kind: "skill", id: row.id, summary: row.summary, body: row.body });
            continue;
        }
        if (row.kind === "custom_message" && open !== null) {
            open.items.push({
                kind: "custom_message",
                id: row.id,
                customType: row.customType,
                label: row.label,
                summary: row.summary,
                body: row.body,
            });
            continue;
        }

        flush();
        if (row.kind === "user") sentAt = row.message.timestamp;
        slots.push({ kind: "entry", key: row.id, row });
    }

    flush();
    return slots;
}

function push(block: Open, row: Extract<TranscriptRow, { kind: "assistant" }>): void {
    const message = row.message;
    const working = message.stopReason === "pending";
    block.live ||= row.live !== undefined;

    message.content.forEach((part, index) => {
        if (part.type === "thinking") {
            // A thought is a row of its own, never a count: it is an entry of the session, and a
            // reader who returns to it must find it where pi wrote it.
            if (part.thinking.trim() === "") return;
            block.items.push({
                kind: "thinking",
                id: `${row.id}-thinking-${index}`,
                thinking: part.thinking,
                streaming: working && index === message.content.length - 1,
            });
            return;
        }
        if (part.type === "text") {
            if (part.text.trim() === "") return;
            block.items.push({ kind: "text", id: `${row.id}-text-${index}`, text: part.text });
            return;
        }
        if (part.type !== "toolCall") return;

        const call: LiveCall | undefined = row.live?.calls.get(part.id);
        const result: ToolResultMessage | null =
            call?.result ?? row.results.get(part.id) ?? failedCall(message, part.id, part.name);
        const presentation = presentCall(part.name, part.arguments, result, working, call?.running ?? false);

        block.calls += 1;
        if (presentation.status === "failed") block.failed += 1;
        if (WRITES.has(part.name) && presentation.detail) block.files.add(presentation.detail);
        block.items.push({ kind: "call", id: `${row.id}-${part.id}`, tool: part.name, presentation });
    });

    block.latest = row;
}

function close(block: Open): FoldSlot {
    const message = block.latest.message;
    // The words a run finished on are the answer, live or settled: while the model is still
    // writing, they are the answer being written, and the moment a call follows them they are
    // the turn's work instead. Both cases are the same rule - what stands after the last call is
    // what a reader came for, and it stands outside the fold.
    const answer = trailingText(block, message);
    // A run at work has no end yet: its heading counts against this moment, and freezes onto
    // pi's own number - or the last message's timestamp - when it settles.
    const endsAt = block.live ? Date.now() : message.timestamp + (message.durationMs ?? 0);
    const startedAt = block.sentAt ?? message.timestamp;

    return {
        kind: "work",
        key: `work:${block.id}`,
        live: block.live,
        items:
            answer === null ? block.items : block.items.filter((item) => !answer.parts.some((p) => p.id === item.id)),
        answer,
        note: block.live ? null : stopNote(message),
        facts: {
            workedMs: Math.max(0, endsAt - startedAt),
            calls: block.calls,
            files: block.files.size,
            failed: block.failed,
        },
    };
}

/**
 * The text a settled turn finished on: what the last message wrote after its last call.
 * Text before that call is part of the work, and goes inside the fold.
 */
function trailingText(block: Open, message: AssistantMessage): WorkAnswer | null {
    let lastCall = -1;
    message.content.forEach((part, index) => {
        if (part.type === "toolCall") lastCall = index;
    });

    const parts: { id: string; text: string }[] = [];
    message.content.forEach((part, index) => {
        if (part.type !== "text" || index <= lastCall) return;
        if (part.text.trim() === "") return;
        parts.push({ id: `${block.latest.id}-text-${index}`, text: part.text });
    });

    return parts.length > 0 ? { id: block.latest.id, parts } : null;
}
