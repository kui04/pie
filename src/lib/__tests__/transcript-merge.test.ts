/**
 * The merge of one session: a base read, the overlay of the records that arrived after it,
 * and the live rows a run writes - the rules of `lib/transcript-merge.ts`.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage, EntriesData, SessionEntry } from "@/lib/rpc-protocol";
import { assistant, bashExecution, chain, messageEntry, usage, user } from "@/preview/fixtures";
import {
    acceptEntry,
    acceptSnapshot,
    bashAfter,
    emptyStream,
    identity,
    liveDelta,
    liveEnd,
    liveRetrying,
    liveStart,
    liveToolEnd,
    liveToolStart,
    liveToolUpdate,
    mergedTranscript,
    type Overlay,
    type StreamState,
} from "@/lib/transcript-merge";

const AT = "2026-10-05T00:00:00.000Z";

/** An entry of the session file, in the shape the fold reads. */
function entryOf(id: string, message: AgentMessage, parentId: string | null = null): SessionEntry {
    return { type: "message", id, parentId, timestamp: AT, message };
}

/** The overlay of the entries given, in the order given. */
function overlayOf(entries: SessionEntry[]): Overlay {
    return {
        entries: new Map(entries.map((entry) => [entry.id, entry])),
        order: entries.map((entry) => entry.id),
        leaf: entries.length > 0 ? entries[entries.length - 1].id : null,
    };
}

/** An answer of the model, as a run writes it: the deltas build its content. */
function pending(timestamp?: number): AgentMessage {
    return assistant([], {
        stopReason: "pending",
        ...(timestamp ? { timestamp } : {}),
    });
}

describe("the transcript the fold reads", () => {
    it("dedupes with the base winning, and keeps the overlay entries the base lacks", () => {
        const base: EntriesData = { entries: [entryOf("a", user("hello"))], leafId: "a" };
        const overlay = overlayOf([entryOf("a", user("hello")), entryOf("late", user("later"), "a")]);

        const merged = mergedTranscript(base, overlay);

        expect(merged.order).toEqual(["a", "late"]);
        expect(merged.leaf).toBe("late");
    });

    it("takes the overlay leaf only when the base does not carry it", () => {
        const base: EntriesData = {
            entries: [entryOf("a", user("hello")), entryOf("b", user("again"), "a")],
            leafId: "b",
        };

        // The overlay holds an entry the base carries: not newer than the base.
        expect(mergedTranscript(base, overlayOf([entryOf("b", user("again"), "a")])).leaf).toBe("b");
        // And one it does not: newer.
        expect(mergedTranscript(base, overlayOf([entryOf("late", user("later"), "b")])).leaf).toBe("late");
    });

    it("answers the overlay alone when no base read has landed", () => {
        const merged = mergedTranscript(null, overlayOf([entryOf("a", user("hello"))]));

        expect(merged.order).toEqual(["a"]);
        expect(merged.leaf).toBe("a");
    });
});

describe("a base read", () => {
    it("drops the entries it carries, keeps the rest, and recomputes the leaf", () => {
        let state = emptyStream();
        state = acceptEntry(state, entryOf("a", user("hello")));
        state = acceptEntry(state, entryOf("late", user("later"), "a"));

        state = acceptSnapshot(state, { entries: [entryOf("a", user("hello"))], leafId: "a" });

        expect(state.overlay.order).toEqual(["late"]);
        expect(state.overlay.leaf).toBe("late");
    });

    it("supersedes the live row of a message it carries, and keeps the row's name", () => {
        let state = emptyStream();
        state = liveStart(state, pending());
        const name = state.live.messages[0].id;

        state = acceptSnapshot(state, { entries: [entryOf("e1", pending())], leafId: "e1" });

        expect(state.live.messages).toEqual([]);
        expect(state.rowIds.get("e1")).toBe(name);
    });

    it("prunes the names of the entries it does not carry", () => {
        let state: StreamState = { ...emptyStream(), rowIds: new Map([["gone", "live-1"]]) };

        state = acceptSnapshot(state, { entries: [entryOf("a", user("hello"))], leafId: "a" });

        expect(state.rowIds.has("gone")).toBe(false);
    });

    it("takes the shell card down with the entry of its run", () => {
        let state: StreamState = {
            ...emptyStream(),
            bash: { command: "ls", output: "one\n", excludeFromContext: false },
        };

        state = acceptSnapshot(state, { entries: chain(messageEntry(bashExecution("ls", "one\n"))), leafId: "e1" });

        expect(state.bash).toBeNull();
    });

    it("settles the usage of a response its entry carries", () => {
        let state = emptyStream();
        state = liveStart(state, pending());
        state = liveDelta(state, { type: "text_delta", contentIndex: 0, delta: "hi" }, usage({ totalTokens: 30 }), 5);
        expect(state.usage?.usage.totalTokens).toBe(30);

        state = acceptSnapshot(state, { entries: [entryOf("e1", pending())], leafId: "e1" });

        expect(state.usage).toBeNull();
    });
});

describe("an appended entry", () => {
    it("appends once, follows the leaf, and does not write a duplicate twice", () => {
        let state = emptyStream();
        state = acceptEntry(state, entryOf("a", user("hello")));
        state = acceptEntry(state, entryOf("b", user("again"), "a"));
        expect(state.overlay.order).toEqual(["a", "b"]);
        expect(state.overlay.leaf).toBe("b");

        state = acceptEntry(state, entryOf("a", user("hello")));

        expect(state.overlay.order).toEqual(["a", "b"]);
    });
});

describe("the shell card", () => {
    it("goes when the entry of its own command arrived, and stays for another command", () => {
        const card = { command: "ls", output: "", excludeFromContext: false };
        const [own] = chain(messageEntry(bashExecution("ls", "one\n")));
        const [other] = chain(messageEntry(bashExecution("sleep 60", "two\n")));

        expect(bashAfter(card, [own])).toBeNull();
        expect(bashAfter(card, [other])).toEqual(card);
    });
});

describe("the live run", () => {
    it("builds the answer from its deltas, and takes a name per message", () => {
        let state = emptyStream();
        state = liveStart(state, pending());
        expect(state.live.messages[0].id).toBe("live-1");

        state = liveDelta(state, { type: "text_delta", contentIndex: 0, delta: "half " }, usage(), 1);
        state = liveDelta(state, { type: "text_delta", contentIndex: 0, delta: "an answer" }, usage(), 2);

        expect(state.live.messages[0].message).toMatchObject({
            content: [{ type: "text", text: "half an answer" }],
        });
    });

    it("writes a tool call into the message it belongs to, and marks a retrying turn", () => {
        let state = emptyStream();
        state = liveStart(state, pending());
        // The call arrives as the model writes it, and the run of it fills the card.
        state = liveDelta(state, { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" }, usage(), 1);
        state = liveToolStart(state, { toolCallId: "c1", args: { command: "ls" } });
        state = liveToolUpdate(state, { toolCallId: "c1", toolName: "bash", partialResult: { output: "one\n" } });
        state = liveToolEnd(state, { toolCallId: "c1", toolName: "bash", result: { output: "one\n" }, isError: false });

        const [live] = state.live.messages;
        expect(live.calls.get("c1")).toMatchObject({ running: false, result: { role: "toolResult" } });

        state = liveRetrying(state);
        expect(state.live.messages[0].retrying).toBe(true);
    });

    it("takes a message that finished as the authority over the deltas", () => {
        let state = emptyStream();
        state = liveStart(state, pending());
        state = liveDelta(state, { type: "text_delta", contentIndex: 0, delta: "half" }, usage(), 1);

        state = liveEnd(state, assistant([{ type: "text", text: "the answer" }], { stopReason: "stop" }));

        expect(state.live.messages[0].message).toMatchObject({ content: [{ type: "text", text: "the answer" }] });
    });

    it("meets an entry and a live row on the timestamp pi records both with", () => {
        expect(identity(pending(7))).toBe("assistant:7");
    });
});
