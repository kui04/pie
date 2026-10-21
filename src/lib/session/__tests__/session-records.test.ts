/**
 * The table of the records: the phase and the drawing of each kind, and the words of a
 * retry - the RPC-only `extension_error` included.
 */

import { describe, expect, it } from "vitest";
import type { Event as SessionRecord } from "@/lib/rpc-protocol";
import { noticeOf, reading } from "../records";

/** A record of the wire, in the shape the machine hands the table. */
function record(type: SessionRecord["type"], more: Record<string, unknown> = {}): SessionRecord {
    return { type, ...more } as SessionRecord;
}

/** An answer of the model, as `message_start` and `message_end` carry it. */
function assistant(content = "an answer") {
    return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: content }],
        timestamp: 1,
        stopReason: "pending" as const,
    };
}

/** The cumulative usage a `message_update` reports. */
function usage() {
    return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };
}

describe("reading", () => {
    it("reads the beginning, the answer and the end of a run", () => {
        expect(reading(record("agent_start")).run).toBe("begin");
        expect(reading(record("message_start", { message: { role: "user" } })).run).toBe("begin");
        expect(reading(record("message_start", { message: assistant() })).run).toBe("write");
        expect(reading(record("agent_end", { willRetry: true })).run).toBe("other");
        expect(reading(record("agent_end", { willRetry: false })).run).toBe("end");
        expect(reading(record("agent_settled")).run).toBe("end");
    });

    it("draws the message of a start, the delta of the answer, and the final message", () => {
        expect(reading(record("message_start", { message: assistant() })).draws).toMatchObject({ kind: "liveStart" });
        expect(
            reading(
                record("message_update", {
                    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
                    usage: usage(),
                }),
            ).draws,
        ).toMatchObject({ kind: "liveDelta" });
        expect(reading(record("message_end", { message: assistant() })).draws).toMatchObject({ kind: "liveEnd" });
        expect(reading(record("agent_end", { willRetry: true })).draws).toEqual({ kind: "retrying" });
    });

    it("opens no card for a call a tool made", () => {
        const nested = reading(record("tool_execution_start", { toolCallId: "t1", args: {}, parentToolCallId: "p1" }));
        expect(nested.draws).toBeNull();

        const own = reading(record("tool_execution_start", { toolCallId: "t1", args: {} }));
        expect(own.draws).toMatchObject({ kind: "toolStart", toolCallId: "t1" });
    });

    it("makes the reads a record leaves stale", () => {
        expect(reading(record("session_info_changed")).invalidates).toEqual(["state"]);
        expect(reading(record("message_end", { message: assistant() })).invalidates).toEqual(["stats"]);
        expect(reading(record("agent_settled")).invalidates).toEqual(["whole"]);
        expect(reading(record("agent_settled")).settles).toBe(true);
    });

    it("reads the RPC-only extension failure as a notice", () => {
        const spec = reading(
            record("extension_error", { extensionPath: "/ext/one.ts", event: "tool_call", error: "boom" }),
        );
        expect(spec.notice).toEqual({
            kind: "extension-error",
            extensionPath: "/ext/one.ts",
            event: "tool_call",
            error: "boom",
        });
        expect(spec.draws).toBeNull();
    });
});

describe("noticeOf", () => {
    it("announces an extension failure under one id, so a second replaces the first", () => {
        const one = noticeOf(
            { kind: "extension-error", extensionPath: "/ext/one.ts", event: "tool_call", error: "boom" },
            null,
        );
        expect(one).toMatchObject({
            kind: "show",
            tone: "warning",
            id: "session-extension-error",
            title: "An extension failed",
        });
        expect(one?.kind === "show" && one.description).toBe("/ext/one.ts (tool_call): boom");

        const two = noticeOf(
            { kind: "extension-error", extensionPath: "/ext/two.ts", event: "turn_end", error: "again" },
            null,
        );
        expect(two).toMatchObject({ kind: "show", id: "session-extension-error" });
    });

    it("names the attempt of the summary retry that runs now", () => {
        const words = noticeOf({ kind: "summary-attempt-start", source: "compaction" }, { attempt: 2, maxAttempts: 4 });
        expect(words?.kind === "show" && words.description).toBe("Compacting the context - attempt 2 of 4");
    });

    it("takes the words of a request retry back when pi succeeds", () => {
        expect(noticeOf({ kind: "auto-retry-end", success: true, finalError: "" }, null)).toEqual({
            kind: "dismiss",
            id: "session-retry",
        });
    });
});
