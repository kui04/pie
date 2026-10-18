/**
 * The chart of a session: the feed (opening, live, failed), the transcript (empty until a
 * base read, then ready), and the phase of the run (idle, waiting, working), with the read
 * authority that keeps a late answer from outranking a record.
 *
 * The listeners are stubbed here, so the graph is walked with no Tauri runtime and no event
 * bus: the registry hands these deps in (`lib/sessions.ts`).
 */

import { getShortestPaths } from "@xstate/graph";
import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import type { PieError, SessionLifecycle } from "@/lib/bridge";
import type { AgentMessage, Event as SessionRecord, SessionEntry } from "@/lib/rpc-protocol";
import type { Notice } from "@/lib/session-records";
import { liveRows } from "@/lib/stream";
import {
    isListening,
    isReady,
    phaseOf,
    sessionMachine,
    type SessionDeps,
    type SessionEvent,
    type SessionSnapshot,
} from "@/machines/session.machine";
import { assistant, bashExecution, usage } from "@/preview/fixtures";

/** The deps of a test: a feed that never opens on its own, and reads and words that are kept. */
function deps(overrides: Partial<SessionDeps> = {}) {
    const reads: string[] = [];
    const notices: Notice[] = [];
    const stubs = {
        listen: () => new Promise<never>(() => undefined),
        reRead: (target: string) => void reads.push(target),
        notice: (notice: Notice) => void notices.push(notice),
        ...overrides,
    };
    return { deps: stubs as SessionDeps, reads, notices, stubs };
}

/** A state of this chart, as a test names it. */
type StateTarget = Parameters<SessionSnapshot["matches"]>[0];

/** The failure of a listener, in the shape Rust reports one. */
const REFUSED: PieError = { type: "rpc", message: "the bus refused the listener", error: { kind: "closed" } };

/** The same, for the paths of the graph walk. */
const GONE: PieError = { type: "rpc", message: "gone", error: { kind: "closed" } };

/** A record of the wire, in the shape the feed hands it over. */
function record(type: SessionRecord["type"], more: Record<string, unknown> = {}): SessionRecord {
    return { type, ...more } as SessionRecord;
}

function user(timestamp: number): AgentMessage {
    return { role: "user", content: "hello", timestamp };
}

function assistantMessage(timestamp: number): AgentMessage {
    return { ...assistant([], { stopReason: "pending" as const }), timestamp };
}

/** An entry of the session file, in the shape the fold reads. */
function entryOf(id: string, message: AgentMessage, parentId: string | null = null): SessionEntry {
    return { type: "message", id, parentId, timestamp: "2026-10-05T00:00:00.000Z", message };
}

/** An actor that opened its listeners and took a base read of one entry. */
function opened(start = deps()) {
    const actor = createActor(sessionMachine, { input: start.deps }).start();
    actor.send({ type: "FEED_OPEN", at: 10 });
    actor.send({ type: "SNAPSHOT", data: { entries: [entryOf("a", user(1))], leafId: "a" }, at: 10 });
    return { actor, ...start };
}

describe("the feed of a session", () => {
    it("opens before it listens, and asks the reads again", () => {
        const start = deps();
        const actor = createActor(sessionMachine, { input: start.deps }).start();
        expect(actor.getSnapshot().matches({ feed: "opening" })).toBe(true);

        actor.send({ type: "FEED_OPEN", at: 10 });

        expect(isListening(actor.getSnapshot())).toBe(true);
        expect(start.reads).toEqual(["whole"]);
    });

    it("holds a failure of the subscription, and reopens on request", () => {
        const start = deps();
        const actor = createActor(sessionMachine, { input: start.deps }).start();
        actor.send({ type: "FEED_FAILED", error: REFUSED });

        expect(actor.getSnapshot().matches({ feed: "failed" })).toBe(true);
        expect(actor.getSnapshot().context.error).toEqual(REFUSED);

        actor.send({ type: "REOPEN" });
        expect(actor.getSnapshot().matches({ feed: "opening" })).toBe(true);
        // The reason of the attempt before it is gone with the state.
        expect(actor.getSnapshot().context.error).toBeNull();
    });

    it("asks the reads again when the pi of the session is gone", () => {
        const { actor, reads } = opened();
        reads.length = 0;

        actor.send({ type: "FEED_STALE" });

        expect(reads).toEqual(["whole"]);
        // The feed itself is unchanged: the reads report what the host said.
        expect(isListening(actor.getSnapshot())).toBe(true);
    });

    it("takes a gap in the records as a read, and an end as a stale one", async () => {
        let life: ((life: SessionLifecycle) => void) | undefined;
        const start = deps({
            listen: async (_onRecord, onLifecycle) => {
                life = onLifecycle;
                return () => undefined;
            },
        });
        const actor = createActor(sessionMachine, { input: start.deps }).start();
        await vi.waitFor(() => expect(isListening(actor.getSnapshot())).toBe(true));
        start.reads.length = 0;

        // The pipe of this session fell behind and records went missing: the reads are the
        // repair, and the feed itself is untouched - the pipe is alive.
        life?.({ type: "lagged" });
        expect(isListening(actor.getSnapshot())).toBe(true);
        expect(start.reads).toEqual(["whole"]);

        // The pi itself is gone: the reads have to say so. The feed stays where it is, too.
        start.reads.length = 0;
        life?.({ type: "ended", termination: { type: "exited", code: 0, success: true } });
        expect(isListening(actor.getSnapshot())).toBe(true);
        expect(start.reads).toEqual(["whole"]);
    });

    it("draws nothing while the feed is not live, and still makes a read stale", () => {
        const start = deps();
        const actor = createActor(sessionMachine, { input: start.deps }).start();
        actor.send({ type: "FEED_FAILED", error: GONE });
        start.reads.length = 0;

        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: assistantMessage(2) }) });
        actor.send({ type: "RECORD", at: 0, record: record("session_info_changed") });

        // The rows of a session nobody is attached to are not this screen's; the read is stale
        // either way.
        expect(actor.getSnapshot().context.live.messages).toEqual([]);
        expect(start.reads).toEqual(["state"]);
    });
});

describe("the transcript of a session", () => {
    it("takes a base read, and moves empty to ready", () => {
        const start = deps();
        const actor = createActor(sessionMachine, { input: start.deps }).start();
        actor.send({ type: "FEED_OPEN", at: 10 });
        expect(isReady(actor.getSnapshot())).toBe(false);

        actor.send({
            type: "SNAPSHOT",
            data: { entries: [entryOf("a", user(1)), entryOf("b", user(2), "a")], leafId: "b" },
            at: 10,
        });

        expect(isReady(actor.getSnapshot())).toBe(true);
        expect(actor.getSnapshot().context.lastSnapshotAt).toBe(10);
        expect(actor.getSnapshot().context.overlay.order).toEqual([]);
    });

    it("ignores a base read older than the one it holds", () => {
        const { actor } = opened();
        actor.send({
            type: "SNAPSHOT",
            data: { entries: [entryOf("a", user(1)), entryOf("b", user(2), "a")], leafId: "b" },
            at: 20,
        });

        actor.send({ type: "SNAPSHOT", data: { entries: [entryOf("a", user(1))], leafId: "a" }, at: 15 });

        expect(actor.getSnapshot().context.lastSnapshotAt).toBe(20);
    });

    it("keeps an appended entry the answer does not carry, and takes the one it does", () => {
        const { actor } = opened();

        actor.send({
            type: "RECORD",
            at: 0,
            record: record("entry_appended", { entry: entryOf("late", user(3), "a") }),
        });
        expect(actor.getSnapshot().context.overlay.order).toEqual(["late"]);

        // The next answer carries it: the base is the authority, and the duplicate goes.
        actor.send({
            type: "SNAPSHOT",
            data: { entries: [entryOf("a", user(1)), entryOf("late", user(3), "a")], leafId: "late" },
            at: 20,
        });
        expect(actor.getSnapshot().context.overlay.order).toEqual([]);
    });

    it("supersedes the live row the entry of a message is", () => {
        const { actor } = opened();
        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: assistantMessage(20) }) });
        expect(liveRows(actor.getSnapshot().context.live)).toHaveLength(1);

        actor.send({
            type: "SNAPSHOT",
            data: { entries: [entryOf("a", user(1)), entryOf("e1", assistantMessage(20), "a")], leafId: "e1" },
            at: 20,
        });

        const context = actor.getSnapshot().context;
        expect(context.live.messages).toEqual([]);
        expect(context.rowIds.get("e1")).toBe("live-1");
    });
});

describe("the run of a session", () => {
    it("starts idle, before anything is read or heard", () => {
        expect(phaseOf(createActor(sessionMachine, { input: deps().deps }).start().getSnapshot())).toBe("idle");
    });

    it("waits from the send, works while the answer arrives, and is idle when the run settles", () => {
        const { actor } = opened();

        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: user(1) }) });
        expect(phaseOf(actor.getSnapshot())).toBe("waiting");

        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: assistantMessage(2) }) });
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        actor.send({
            type: "RECORD",
            at: 0,
            record: record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half " },
                usage: usage(),
            }),
        });
        actor.send({
            type: "RECORD",
            at: 0,
            record: record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "an answer" },
                usage: usage(),
            }),
        });
        const rows = liveRows(actor.getSnapshot().context.live);
        expect(rows[rows.length - 1]).toMatchObject({ kind: "assistant" });

        actor.send({ type: "RECORD", at: 0, record: record("message_end", { message: assistantMessage(2) }) });
        actor.send({ type: "RECORD", at: 0, record: record("agent_settled") });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("settles the phase from a read even when a delta arrived first", () => {
        // A screen that mounted in the middle of a run: the listeners open, a delta of the
        // answer arrives before the state read does, and a delta says nothing about the
        // phase. The read still may set it: no phase record was heard.
        const { actor } = opened();
        actor.send({
            type: "RECORD",
            at: 0,
            record: record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" },
                usage: usage(),
            }),
        });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");

        actor.send({ type: "STATE_READ", streaming: true, at: Date.now() + 1_000 });

        expect(phaseOf(actor.getSnapshot())).toBe("working");
    });

    it("lets the newer of two reads settle the phase", () => {
        const { actor } = opened();

        actor.send({ type: "STATE_READ", streaming: true, at: Date.now() + 1_000 });
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        actor.send({ type: "STATE_READ", streaming: false, at: Date.now() + 2_000 });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("does not let a read formed before the listeners opened move the phase", () => {
        const actor = createActor(sessionMachine, { input: deps().deps }).start();
        // The hook sends the read it holds when the listeners open, and that answer may have
        // been formed before them - a cache from a mount that has gone.
        const opened = Date.now();
        actor.send({ type: "FEED_OPEN", at: opened });

        actor.send({ type: "STATE_READ", streaming: true, at: opened - 1_000 });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");

        actor.send({ type: "STATE_READ", streaming: true, at: opened + 1_000 });
        expect(phaseOf(actor.getSnapshot())).toBe("working");
    });

    it("keeps a run record over a read that was answered before it", () => {
        const { actor } = opened();
        actor.send({ type: "RECORD", at: 0, record: record("agent_start") });

        actor.send({ type: "STATE_READ", streaming: false, at: Date.now() + 1_000 });

        expect(phaseOf(actor.getSnapshot())).toBe("waiting");
    });

    it("keeps the increment for a read that was written before the settle, and drops it for the one after", () => {
        const { actor } = opened();
        actor.send({ type: "RECORD", at: 100, record: record("message_start", { message: assistantMessage(2) }) });
        actor.send({
            type: "RECORD",
            at: 110,
            record: record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
                usage: usage({ totalTokens: 30 }),
            }),
        });
        expect(actor.getSnapshot().context.usage?.usage.totalTokens).toBe(30);
        expect(actor.getSnapshot().context.settledAt).toBeNull();

        // The response is in the session file now: the next read that was written after this
        // moment carries its usage, and the increment would be the same tokens twice.
        actor.send({ type: "RECORD", at: 120, record: record("agent_settled") });
        expect(actor.getSnapshot().context.settledAt).toBe(120);

        // This answer was written before the settle: the response may not be in it, so the
        // increment stays - and the intent is not burnt, the next answer still settles it.
        actor.send({ type: "STATS_READ", at: 110 });
        expect(actor.getSnapshot().context.usage?.usage.totalTokens).toBe(30);
        expect(actor.getSnapshot().context.settledAt).toBe(120);

        actor.send({ type: "STATS_READ", at: 120 });
        expect(actor.getSnapshot().context.usage).toBeNull();
        expect(actor.getSnapshot().context.settledAt).toBeNull();
    });

    it("keeps the increment when the answer predates a delta that followed the settle", () => {
        const { actor } = opened();
        actor.send({ type: "RECORD", at: 120, record: record("agent_settled") });
        expect(actor.getSnapshot().context.settledAt).toBe(120);
        // A second run opens on the same session: its increment is newer than the settle of
        // the first one, so an answer written between the two covers neither of them.
        actor.send({
            type: "RECORD",
            at: 130,
            record: record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
                usage: usage({ totalTokens: 30 }),
            }),
        });

        actor.send({ type: "STATS_READ", at: 125 });

        expect(actor.getSnapshot().context.usage?.usage.totalTokens).toBe(30);
        expect(actor.getSnapshot().context.settledAt).toBe(120);
    });

    it("clears the increment of a run whose pi is gone, and asks every read again", () => {
        const { actor, reads } = opened();
        actor.send({
            type: "RECORD",
            at: 110,
            record: record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
                usage: usage({ totalTokens: 30 }),
            }),
        });
        reads.length = 0;

        // No settle record is coming for this run, so nothing of it may be shown.
        actor.send({ type: "FEED_STALE" });

        expect(actor.getSnapshot().context.usage).toBeNull();
        expect(actor.getSnapshot().context.settledAt).toBeNull();
        expect(reads).toEqual(["whole"]);
    });

    it("runs a shell command of the reader, and takes the card down with its entry", () => {
        const { actor } = opened();
        actor.send({ type: "BASH_START", run: { command: "ls", excludeFromContext: false } });
        expect(actor.getSnapshot().context.bash).toMatchObject({ command: "ls", output: "" });

        actor.send({ type: "RECORD", at: 0, record: record("bash_execution_update", { delta: "one\n" }) });
        expect(actor.getSnapshot().context.bash?.output).toBe("one\n");

        // The entry of the run is the record of it, whichever read brings it.
        const entry: SessionEntry = entryOf("bash", bashExecution("ls", "one\n"));
        actor.send({ type: "RECORD", at: 0, record: record("entry_appended", { entry }) });
        expect(actor.getSnapshot().context.bash).toBeNull();

        // A command that never ran has no entry: the card goes on the event.
        actor.send({ type: "BASH_START", run: { command: "false", excludeFromContext: true } });
        actor.send({ type: "BASH_DROPPED" });
        expect(actor.getSnapshot().context.bash).toBeNull();
    });

    it("carries the words of a retry to the notice", () => {
        const { actor, notices } = opened();

        actor.send({
            type: "RECORD",
            at: 0,
            record: record("auto_retry_start", {
                attempt: 1,
                maxAttempts: 3,
                delayMs: 500,
                errorMessage: "overloaded",
            }),
        });

        expect(notices).toEqual([
            {
                kind: "show",
                id: "session-retry",
                tone: "warning",
                title: "Pi is retrying the request",
                description: "overloaded - attempt 1 of 3",
            },
        ]);
    });

    it("asks every read again when a gap in the records is reported, and keeps the screen", () => {
        const start = opened();
        const { actor, reads } = start;
        // The reader is looking at a run that streams, at an entry the base read does not
        // carry, and a message queued behind it.
        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: user(1) }) });
        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: assistantMessage(2) }) });
        actor.send({
            type: "RECORD",
            at: 0,
            record: record("entry_appended", { entry: entryOf("late", user(3), "a") }),
        });
        actor.send({ type: "RECORD", at: 0, record: record("queue_update", { steering: ["go on"], followUp: [] }) });
        expect(actor.getSnapshot().context.readAuthoritative).toBe(false);
        expect(actor.getSnapshot().context.overlay.order).toEqual(["late"]);
        const rows = liveRows(actor.getSnapshot().context.live);
        expect(rows.map((row) => row.kind)).toEqual(["user", "assistant"]);
        reads.length = 0;

        actor.send({ type: "GAP", at: Date.now() });

        // What arrived is still on screen, the entry that the base read does not carry with
        // it: the base read supersedes it as its answer lands.
        expect(actor.getSnapshot().matches({ transcript: "ready" })).toBe(true);
        expect(actor.getSnapshot().context.overlay.order).toEqual(["late"]);
        expect(liveRows(actor.getSnapshot().context.live)).toEqual(rows);
        expect(phaseOf(actor.getSnapshot())).toBe("working");
        // The queue is written by records alone, and the ones this gap swallowed are gone.
        expect(actor.getSnapshot().context.queued).toEqual({ steering: [], followUp: [] });
        // A read may set the phase again, and every read is asked for.
        expect(actor.getSnapshot().context.readAuthoritative).toBe(true);
        expect(reads).toEqual(["whole"]);
        // The feed is live: a gap in the records is not the end of a session.
        expect(isListening(actor.getSnapshot())).toBe(true);
    });

    it("hands the deltas it held over before it reports a gap", async () => {
        let hear: ((record: SessionRecord) => void) | undefined;
        let life: ((life: SessionLifecycle) => void) | undefined;
        const start = deps({
            listen: async (onRecord, onLifecycle) => {
                hear = onRecord;
                life = onLifecycle;
                return () => undefined;
            },
        });
        const actor = createActor(sessionMachine, { input: start.deps }).start();
        await vi.waitFor(() => expect(isListening(actor.getSnapshot())).toBe(true));

        // A delta waits for its frame, and the gap arrives in between: the row may not lose
        // the text the model had already written, so the held deltas go first.
        hear?.(record("message_start", { message: assistantMessage(2) }));
        hear?.(
            record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" },
                usage: usage({ totalTokens: 1 }),
            }),
        );
        life?.({ type: "lagged" });

        const [live] = actor.getSnapshot().context.live.messages;
        expect(live.message).toMatchObject({ content: [{ type: "text", text: "half" }] });
        expect(actor.getSnapshot().context.readAuthoritative).toBe(true);
    });

    it("ignores a read that was answered before the gap, and takes the one answered after it", () => {
        const { actor } = opened();
        actor.send({ type: "RECORD", at: 0, record: record("message_start", { message: user(1) }) });
        const before = Date.now();
        actor.send({ type: "GAP", at: before });

        // This answer was written before the gap: it is about a stretch of the stream this
        // screen can no longer follow, and the records that would correct it are the ones
        // that went. The clock of the reset is the clock of the answers.
        actor.send({ type: "STATE_READ", streaming: false, at: before - 1 });
        expect(phaseOf(actor.getSnapshot())).toBe("waiting");

        actor.send({ type: "STATE_READ", streaming: false, at: Date.now() + 1_000 });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("reaches every state of the feed, the transcript and the run on the graph-enumerated shortest paths", () => {
        const { deps: walkable } = deps();
        const everyEvent: SessionEvent[] = [
            { type: "FEED_OPEN", at: 10 },
            { type: "FEED_FAILED", error: GONE },
            { type: "FEED_STALE" },
            { type: "REOPEN" },
            { type: "STATE_READ", streaming: true, at: Date.now() + 60_000 },
            { type: "SNAPSHOT", data: { entries: [entryOf("a", user(1))], leafId: "a" }, at: Date.now() + 60_000 },
            { type: "RECORD", at: 0, record: record("agent_start") },
            { type: "RECORD", at: 0, record: record("message_start", { message: assistantMessage(2) }) },
            { type: "RECORD", at: 0, record: record("agent_settled") },
        ];

        for (const target of [
            { feed: "opening" },
            { feed: "live" },
            { feed: "failed" },
            { transcript: "empty" },
            { transcript: "ready" },
            { run: "idle" },
            { run: "waiting" },
            { run: "working" },
        ]) {
            const paths = getShortestPaths(sessionMachine, {
                events: everyEvent,
                input: walkable,
                toState: (state) => state.matches(target as StateTarget),
            });
            expect(paths.length, `no path to ${JSON.stringify(target)}`).toBeGreaterThan(0);
        }
    });

    it("reports a listener that cannot be opened, from the actor that tried", async () => {
        const refused = deps({
            listen: async () => {
                throw REFUSED;
            },
        });
        const actor = createActor(sessionMachine, { input: refused.deps }).start();
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ feed: "failed" })).toBe(true));
        expect(actor.getSnapshot().context.error?.message).toBe("the bus refused the listener");
    });
});

/**
 * A fork or a clone replaces the conversation of the same process: the session keeps its
 * id, and everything this side drew belongs to the conversation that is gone.
 */
describe("the conversation that was replaced", () => {
    it("drops what the old conversation drew, and reads again", () => {
        const { actor, reads } = opened();
        // Something of the old conversation is on screen: a live row, and an entry that
        // arrived after the base read.
        actor.send({ type: "RECORD", at: 20, record: record("message_start", { message: assistantMessage(2) }) });
        actor.send({ type: "RECORD", at: 21, record: record("entry_appended", { entry: entryOf("b", user(3), "a") }) });
        expect(actor.getSnapshot().context.live.messages).toHaveLength(1);
        expect(actor.getSnapshot().context.overlay.order).toEqual(["b"]);
        reads.length = 0;

        actor.send({ type: "REPLACED" });

        expect(actor.getSnapshot().context.live.messages).toEqual([]);
        expect(actor.getSnapshot().context.overlay.order).toEqual([]);
        expect(actor.getSnapshot().matches({ transcript: "empty" })).toBe(true);
        expect(actor.getSnapshot().matches({ run: "idle" })).toBe(true);
        expect(reads).toEqual(["whole"]);

        // The base in hand was the conversation that is gone, so the next answer stands
        // for the new one whenever it was written.
        actor.send({ type: "SNAPSHOT", data: { entries: [entryOf("c", user(4))], leafId: "c" }, at: 5 });
        expect(isReady(actor.getSnapshot())).toBe(true);
        expect(actor.getSnapshot().context.lastSnapshotAt).toBe(5);
    });
});
