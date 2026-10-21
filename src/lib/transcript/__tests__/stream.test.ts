import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@/lib/rpc-protocol";
import {
    activityRows,
    applyDelta,
    beginMessage,
    endCall,
    endMessage,
    liveRows,
    markRetrying,
    noRun,
    startCall,
    updateCall,
    type LiveRun,
} from "../stream";

/**
 * The sequences below are the ones a recorded run writes
 * (`src-tauri/tests/fixtures/tour-1.1.0.jsonl`, `transcript-1.1.0.jsonl`): a
 * `message_start` with the parts the provider sent, deltas for one part at a time, a
 * tool call whose arguments stream before it runs, and a result that arrives twice.
 */

function assistant(
    content: AssistantMessage["content"] = [],
    stopReason: AssistantMessage["stopReason"] = "pending",
): { role: "assistant" } & AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic",
        provider: "anthropic",
        model: "claude",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: 100,
    };
}

function started(
    content: AssistantMessage["content"] = [],
    stopReason: AssistantMessage["stopReason"] = "pending",
): LiveRun {
    return beginMessage(noRun, "live-1", assistant(content, stopReason));
}

/** The message of the single live row. */
function live(run: LiveRun): AssistantMessage {
    const [row] = liveRows(run);
    if (row.kind !== "assistant") throw new Error("the run drew no assistant row");
    return row.message;
}

afterEach(() => {
    vi.useRealTimers();
});

function part(run: LiveRun, index: number) {
    return live(run).content[index];
}

/** The live state of one call of the single row. */
function callState(run: LiveRun, id: string) {
    const [row] = liveRows(run);
    if (row.kind !== "assistant") throw new Error("the run drew no assistant row");
    return row.live?.calls.get(id);
}

/** A run with one call in it, started the way the wire starts it. */
function withCall(args: { command: string } = { command: "cat package.json" }): LiveRun {
    let run = started();
    run = applyDelta(run, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" });
    return startCall(run, { toolCallId: "call-1", args });
}

describe("a message a run is writing", () => {
    it("builds the text of a message from its deltas", () => {
        let run = started();
        run = applyDelta(run, { type: "text_start", contentIndex: 0 });
        run = applyDelta(run, { type: "text_delta", contentIndex: 0, delta: "Hel" });
        run = applyDelta(run, { type: "text_delta", contentIndex: 0, delta: "lo" });

        expect(part(run, 0)).toEqual({ type: "text", text: "Hello" });
    });

    it("takes the whole of a part from its end event, over what the deltas built", () => {
        let run = started();
        run = applyDelta(run, { type: "thinking_delta", contentIndex: 0, delta: "half" });
        // A redacted thought may arrive whole at its start, with no delta at all.
        run = applyDelta(run, { type: "thinking_end", contentIndex: 0, content: "the whole thought" });

        expect(part(run, 0)).toEqual({ type: "thinking", thinking: "the whole thought" });
    });

    it("reads a tool call's arguments as its text arrives", () => {
        let run = started();
        run = applyDelta(run, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" });
        run = applyDelta(run, { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/tmp/a' });

        expect(part(run, 0)).toMatchObject({ id: "call-1", name: "write", arguments: { path: "/tmp/a" } });

        run = applyDelta(run, { type: "toolcall_delta", contentIndex: 0, delta: '.ts","content":"hi"}' });
        expect(part(run, 0)).toMatchObject({ arguments: { path: "/tmp/a.ts", content: "hi" } });

        // The end event is the authority over everything the deltas guessed.
        run = applyDelta(run, {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: { type: "toolCall", id: "call-1", name: "write", arguments: { path: "/tmp/a.ts" } },
        });
        expect(part(run, 0)).toMatchObject({ arguments: { path: "/tmp/a.ts" } });
    });

    it("reads a long call at intervals, and takes its end as the authority", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        let run = started();
        run = applyDelta(run, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" });
        run = applyDelta(run, { type: "toolcall_delta", contentIndex: 0, delta: '{"content":"' + "x".repeat(2_048) });
        const first = part(run, 0);
        if (first.type !== "toolCall") throw new Error("the call is not there");
        expect(String(first.arguments.content)).toHaveLength(2_048);

        vi.advanceTimersByTime(10);
        run = applyDelta(run, { type: "toolcall_delta", contentIndex: 0, delta: "y".repeat(10) });
        const held = part(run, 0);
        if (held.type !== "toolCall") throw new Error("the call is not there");
        expect(String(held.arguments.content)).toHaveLength(2_048);

        vi.advanceTimersByTime(120);
        run = applyDelta(run, { type: "toolcall_delta", contentIndex: 0, delta: "z".repeat(10) });
        const read = part(run, 0);
        if (read.type !== "toolCall") throw new Error("the call is not there");
        expect(String(read.arguments.content)).toHaveLength(2_068);
    });

    it("keeps the parts in order when a later index arrives first", () => {
        let run = started();
        run = applyDelta(run, { type: "text_delta", contentIndex: 1, delta: "answer" });

        expect(live(run).content).toHaveLength(2);
        expect(part(run, 0)).toEqual({ type: "text", text: "" });
        expect(part(run, 1)).toEqual({ type: "text", text: "answer" });
    });

    it("drops a delta that no message of the run can take", () => {
        const run = applyDelta(noRun, { type: "text_delta", contentIndex: 0, delta: "lost" });

        expect(run).toEqual(noRun);
    });

    it("takes the final message as it is, with what the run already streamed", () => {
        let run = started();
        run = applyDelta(run, { type: "text_delta", contentIndex: 0, delta: "gone" });
        run = applyDelta(run, { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" });
        run = startCall(run, { toolCallId: "call-1", args: { command: "ls" } });

        run = endMessage(run, assistant([{ type: "text", text: "the answer" }], "stop"));

        expect(live(run).content).toEqual([{ type: "text", text: "the answer" }]);
        // The call that ran keeps its state: its card is the row's, not the message's.
        expect(callState(run, "call-1")).toEqual({ running: true, result: null });
    });

    it("draws only the roles the transcript has a row for", () => {
        const system = beginMessage(noRun, "live-1", { role: "system", content: "rules", timestamp: 1 });
        expect(liveRows(system)).toEqual([]);

        const user = beginMessage(noRun, "live-1", { role: "user", content: "hello", timestamp: 1 });
        expect(liveRows(user)).toEqual([
            { kind: "user", id: "live-1", message: { role: "user", content: "hello", timestamp: 1 } },
        ]);
    });
});

describe("the line under the run", () => {
    it("says nothing while the run is idle", () => {
        // What the run is doing is its own phase, held by the chart of the session
        // (`machines/session.machine.ts`); this function only turns it into a row.
        expect(activityRows("idle")).toEqual([]);
    });

    it("waits for the model's first output", () => {
        // A reader has sent words and nothing of the model is on screen yet: the
        // answer is on its way over a connection that may be far away.
        expect(activityRows("waiting")).toEqual([{ kind: "activity", id: "activity", state: "waiting" }]);
    });

    it("is at work once the model writes, and stays there for what it called", () => {
        expect(activityRows("working")).toEqual([{ kind: "activity", id: "activity", state: "working" }]);
    });
});

describe("a tool call of a running message", () => {
    /** The identity the wire gives the call of these tests. */
    const tool = { toolCallId: "call-1", toolName: "bash" };

    it("replaces what it streamed with what it streamed last", () => {
        let run = withCall();
        run = updateCall(run, { ...tool, partialResult: { content: [{ type: "text", text: "{\n" }] } });
        run = updateCall(run, {
            ...tool,
            partialResult: { content: [{ type: "text", text: '{\n  "name": "pie"\n' }] },
        });

        expect(callState(run, "call-1")).toMatchObject({ running: true });
        expect(callState(run, "call-1")?.result?.content).toEqual([{ type: "text", text: '{\n  "name": "pie"\n' }]);
    });

    it("settles with the result the execution ended with", () => {
        let run = withCall();
        run = endCall(run, { ...tool, result: { content: [{ type: "text", text: "boom" }] }, isError: true });

        expect(callState(run, "call-1")).toMatchObject({ running: false, result: { isError: true } });
        expect(callState(run, "call-1")?.result?.content).toEqual([{ type: "text", text: "boom" }]);
    });

    it("reads the details of a result, which carry a truncation", () => {
        let run = withCall();
        run = endCall(run, {
            ...tool,
            result: {
                content: [{ type: "text", text: "many lines" }],
                details: { truncation: { truncated: true, outputLines: 10, totalLines: 900 } },
            },
            isError: false,
        });

        expect(callState(run, "call-1")?.result?.details).toEqual({
            truncation: { truncated: true, outputLines: 10, totalLines: 900 },
        });
    });

    it("takes the arguments the tool was called with, over the ones it streamed", () => {
        const run = withCall({ command: "ls -la" });

        expect(part(run, 0)).toMatchObject({ arguments: { command: "ls -la" } });
    });

    it("keeps a call that no message carries out of the run", () => {
        expect(endCall(noRun, { ...tool, result: {}, isError: false })).toEqual(noRun);
    });
});

describe("a run that pi takes up again", () => {
    it("says that the failure of its message is not its last word", () => {
        let run = started([{ type: "text", text: "overloaded" }], "error");
        expect(liveRows(run)[0]).toMatchObject({ live: { retrying: false } });

        run = markRetrying(run);

        expect(liveRows(run)[0]).toMatchObject({ live: { retrying: true } });
        expect(live(run).stopReason).toBe("error");
    });
});
