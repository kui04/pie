import { getShortestPaths } from "@xstate/graph";
import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import type { PieError } from "@/lib/bridge";
import type { SessionDeps, SessionEvent } from "@/machines/session.machine";
import { isListening, isSwitching, phaseOf, sessionMachine, type SessionSnapshot } from "@/machines/session.machine";
import type { Event as SessionRecord } from "@/lib/protocol";
import { assistant, usage } from "@/preview/fixtures";

/**
 * The chart of a session: the feed (opening, live, switching, failed) and the run's
 * phase inside it (idle, waiting, working), with the latch that keeps a read from
 * outranking a record.
 *
 * The listeners are stubbed here, so the graph is walked with no Tauri runtime and
 * no event bus: the seam hands these deps in (`hooks/use-session.ts`).
 */

/** The deps of a test: a feed that opens when it is told to, and a table that writes nowhere. */
function deps(overrides: Partial<SessionDeps> = {}) {
    const applied: { record: SessionRecord; drawing: boolean }[] = [];
    const stubs = {
        apply: (record: SessionRecord, drawing: boolean) => void applied.push({ record, drawing }),
        listen: () => new Promise<never>(() => undefined),
        switchSession: async () => ({ cancelled: false }),
        reRead: vi.fn(),
        opened: vi.fn(),
        afterSwitch: vi.fn(),
        ...overrides,
    };
    return { deps: stubs as SessionDeps, applied, stubs: stubs as typeof stubs & { reRead: ReturnType<typeof vi.fn> } };
}

/** The failure of a listener, in the shape Rust reports one. */
const REFUSED: PieError = { type: "rpc", message: "the bus refused the listener", error: { kind: "closed" } };

/** The same, for the paths of the graph walk. */
const GONE: PieError = { type: "rpc", message: "gone", error: { kind: "closed" } };

/** A state of this chart, as a test names it. */
type StateTarget = Parameters<SessionSnapshot["matches"]>[0];

/** A record of the wire, in the shape the feed hands it over. */
function record(type: SessionRecord["type"], more: Record<string, unknown> = {}): SessionRecord {
    return { type, ...more } as SessionRecord;
}

/** An actor that opened its listeners and then heard `records`, in order. */
function after(records: SessionRecord[], start = deps()) {
    const actor = createActor(sessionMachine, { input: start.deps }).start();
    actor.send({ type: "FEED_OPEN" });
    for (const each of records) actor.send({ type: "RECORD", record: each });
    return { actor, ...start };
}

describe("the feed of a session", () => {
    it("opens before it listens, and reads only once the listeners are open", () => {
        const { actor, stubs } = after([]);
        expect(isListening(actor.getSnapshot())).toBe(true);
        expect(stubs.opened).toHaveBeenCalledOnce();
    });

    it("holds a failure of the subscription, and reopens on request", () => {
        const { stubs } = deps();
        const started = createActor(sessionMachine, { input: stubs }).start();
        started.send({ type: "FEED_FAILED", error: REFUSED });
        expect(started.getSnapshot().matches({ feed: "failed" })).toBe(true);
        expect(started.getSnapshot().context.error).toEqual(REFUSED);

        started.send({ type: "REOPEN" });
        expect(started.getSnapshot().matches({ feed: "opening" })).toBe(true);
        // The reason of the attempt before it is gone with the state.
        expect(started.getSnapshot().context.error).toBeNull();
    });

    it("drops the rows of the conversation being left, and keeps what is not a row", () => {
        const { actor, applied, stubs } = after([record("queue_update", { steering: [], followUp: [] })]);
        // What the feed drew while it was live.
        expect(applied).toEqual([{ record: expect.objectContaining({ type: "queue_update" }), drawing: true }]);
        applied.length = 0;
        actor.send({ type: "SWITCH" });
        expect(isSwitching(actor.getSnapshot())).toBe(true);

        const entered = record("entry_appended", { entry: { type: "custom", id: "c1", parentId: null } });
        const stale = record("session_info_changed", {});
        actor.send({ type: "RECORD", record: entered });
        actor.send({ type: "RECORD", record: stale });
        // The entry may belong to the conversation being left; the read it makes stale
        // is stale either way.
        expect(applied).toEqual([
            { record: entered, drawing: false },
            { record: stale, drawing: false },
        ]);

        // And a switch that is abandoned leaves the feed as it was.
        actor.send({ type: "SWITCH_ABANDONED" });
        expect(isSwitching(actor.getSnapshot())).toBe(false);
        expect(stubs.afterSwitch).not.toHaveBeenCalled();
    });

    it("keeps the phase of a run while a switch is in flight", () => {
        // The regions are independent: a switch does not stop the run it is leaving (pi
        // aborts that run only in the switch itself), so the line under the transcript and
        // the key of the composer read the same phase throughout.
        const { actor } = after([record("agent_start"), record("message_start", { message: assistantMessage(2) })]);
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        actor.send({ type: "SWITCH" });
        expect(isSwitching(actor.getSnapshot())).toBe(true);
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        // And a record of that run heard meanwhile moves the phase as it always does.
        actor.send({ type: "RECORD", record: record("agent_settled") });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("recalls the phase of a run when a switch is refused or fails", () => {
        // Pi refuses a switch before it tears the run down, so the conversation in view
        // is the same one and its run goes on: the phase is where it was.
        for (const answer of ["SWITCH_ABANDONED", "SWITCH_FAILED"] as const) {
            const { actor } = after([record("agent_start"), record("message_start", { message: assistantMessage(2) })]);
            expect(phaseOf(actor.getSnapshot())).toBe("working");

            actor.send({ type: "SWITCH" });
            expect(isSwitching(actor.getSnapshot())).toBe(true);

            actor.send({ type: answer });
            expect(isSwitching(actor.getSnapshot())).toBe(false);
            expect(phaseOf(actor.getSnapshot()), answer).toBe("working");
        }
    });

    it("empties what the old conversation owned once the switch is done", () => {
        const { actor, stubs } = after([]);
        actor.send({ type: "SWITCH" });
        actor.send({ type: "SWITCH_DONE" });
        expect(stubs.afterSwitch).toHaveBeenCalledOnce();
        expect(isListening(actor.getSnapshot())).toBe(true);
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("applies a record it cannot draw without writing a row", () => {
        // The fallthrough: a record heard as the feed failed makes a read stale, and draws
        // nothing - the rows of a session nobody is attached to are not this screen's.
        const { stubs, applied } = deps();
        const actor = createActor(sessionMachine, { input: stubs }).start();
        actor.send({
            type: "FEED_FAILED",
            error: GONE,
        });
        expect(actor.getSnapshot().matches({ feed: "failed" })).toBe(true);
        applied.length = 0;
        stubs.reRead.mockClear();

        actor.send({ type: "RECORD", record: record("agent_settled") });
        // The table is stubbed here (it is what asks for a read): what this chart decides
        // is that the record may not draw.
        expect(applied).toEqual([{ record: expect.objectContaining({ type: "agent_settled" }), drawing: false }]);
    });

    it("asks the reads of the session again when its pi is gone", () => {
        const { actor, stubs } = after([]);
        // Opening the listeners asks for a read of its own: the records of the closed
        // listener are gone, and only an answer covers them.
        const onOpen = stubs.reRead.mock.calls.length;

        actor.send({ type: "FEED_STALE" });
        expect(stubs.reRead.mock.calls.length).toBe(onOpen + 1);
        // The feed itself is unchanged: the reads report what the host said.
        expect(isListening(actor.getSnapshot())).toBe(true);
    });
});

describe("the run of a session", () => {
    it("starts idle, before anything is read or heard", () => {
        expect(phaseOf(after([]).actor.getSnapshot())).toBe("idle");
    });

    it("waits from the send until the model writes its first word", () => {
        // The reader's own message begins the run of the screen (`message_start` is
        // what pi answers the prompt with), and no output exists yet.
        expect(phaseOf(after([record("message_start", { message: user(1) })]).actor.getSnapshot())).toBe("waiting");
        expect(phaseOf(after([record("agent_start")]).actor.getSnapshot())).toBe("waiting");
        // The answer of the model is what ends the wait.
        const answer = record("message_start", { message: assistantMessage(2) });
        expect(phaseOf(after([record("agent_start"), answer]).actor.getSnapshot())).toBe("working");
    });

    it("holds the phase while a read of the messages lands under a run", () => {
        // A read that lands mid-run takes the rows the run drew over (the store does
        // that). The phase is not a question about the rows, so the run is still at work
        // until a record says it is over.
        const { actor } = after([record("agent_start"), record("message_start", { message: assistantMessage(2) })]);
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        // The message the run wrote is in the session file now, which is what a read of
        // the entries carries; the run goes on.
        actor.send({ type: "RECORD", record: record("message_end", { message: assistantMessage(2) }) });
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        actor.send({ type: "RECORD", record: record("agent_settled") });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("waits again when another run begins, whatever the one before it was doing", () => {
        // Pi takes a turn up again by itself: the run that follows a retry has written
        // nothing of its own yet, so the line under the transcript waits on it.
        const { actor } = after([
            record("agent_start"),
            record("message_start", { message: assistantMessage(2) }),
            record("agent_end", { willRetry: true, messages: [] }),
        ]);
        expect(phaseOf(actor.getSnapshot())).toBe("working");

        actor.send({ type: "RECORD", record: record("agent_start") });
        expect(phaseOf(actor.getSnapshot())).toBe("waiting");
    });

    it("reads the run of a screen that mounted in the middle of one", () => {
        // The listeners open after the run began, so no `agent_start` arrives for
        // it: the read of the state is all this screen gets.
        const open = deps();
        const actor = createActor(sessionMachine, { input: open.deps }).start();
        actor.send({ type: "FEED_OPEN" });
        actor.send({ type: "STATE_READ", streaming: true });
        expect(phaseOf(actor.getSnapshot())).toBe("working");
    });

    it("keeps a run record over a read that was answered before it", () => {
        // The read is older than the record and arrives later. It must not end a run
        // that just began.
        const { actor } = after([record("agent_start")]);
        actor.send({ type: "STATE_READ", streaming: false });
        expect(phaseOf(actor.getSnapshot())).toBe("waiting");

        // And the other way: a read of a running session cannot hold a run that ended.
        const elsewhere = after([record("agent_start")]);
        elsewhere.actor.send({ type: "STATE_READ", streaming: true });
        elsewhere.actor.send({ type: "RECORD", record: record("agent_end", { willRetry: false, messages: [] }) });
        expect(phaseOf(elsewhere.actor.getSnapshot())).toBe("idle");
    });

    it("keeps working while pi retries, and is idle only when the session settles", () => {
        const retry = after([
            record("agent_start"),
            record("message_start", { message: assistantMessage(2) }),
            record("agent_end", { willRetry: true, messages: [] }),
        ]);
        expect(phaseOf(retry.actor.getSnapshot())).toBe("working");

        retry.actor.send({ type: "RECORD", record: record("agent_settled") });
        expect(phaseOf(retry.actor.getSnapshot())).toBe("idle");
    });

    it("is idle at once when a run ends without a retry", () => {
        expect(
            phaseOf(
                after([
                    record("agent_start"),
                    record("message_start", { message: assistantMessage(2) }),
                    record("agent_end", { willRetry: false, messages: [] }),
                ]).actor.getSnapshot(),
            ),
        ).toBe("idle");
    });

    it("makes the next read the authority after the listeners open again", () => {
        // The listeners were closed and the records in between are gone. The event
        // before the re-open may not decide what the session is doing now.
        const { actor } = after([record("agent_start")]);
        actor.send({ type: "STATE_READ", streaming: false });
        expect(phaseOf(actor.getSnapshot())).toBe("waiting");

        actor.send({ type: "REOPEN" });
        actor.send({ type: "FEED_OPEN" });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");

        actor.send({ type: "STATE_READ", streaming: false });
        expect(phaseOf(actor.getSnapshot())).toBe("idle");
    });

    it("reaches every state of the feed and of the run on the graph-enumerated shortest paths", () => {
        const { deps: walkable } = deps();
        const everyEvent: SessionEvent[] = [
            { type: "FEED_OPEN" },
            { type: "FEED_FAILED", error: GONE },
            { type: "FEED_STALE" },
            { type: "REOPEN" },
            { type: "SWITCH" },
            { type: "SWITCH_DONE" },
            { type: "SWITCH_ABANDONED" },
            { type: "SWITCH_FAILED" },
            { type: "STATE_READ", streaming: true },
            { type: "RECORD", record: record("agent_start") },
            { type: "RECORD", record: record("message_start", { message: assistantMessage(2) }) },
            { type: "RECORD", record: record("agent_settled") },
        ];

        for (const target of [
            { feed: "opening" },
            { feed: "live" },
            { feed: "failed" },
            { switching: "off" },
            { switching: "inFlight" },
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

            // The path is walked, not only counted: a machine that reaches a state
            // through a transition it does not declare is exactly what this catches.
            for (const path of paths) {
                const actor = createActor(sessionMachine, { input: walkable }).start();
                for (const step of path.steps) actor.send(step.event);
                expect(
                    actor.getSnapshot().matches(target as StateTarget),
                    `a path to ${JSON.stringify(target)} landed elsewhere`,
                ).toBe(true);
            }
        }
    });

    it("reports a listener that cannot be opened, from the actor that tried", async () => {
        // No hand-injected FEED_FAILED here: the actor opens the listeners itself and
        // reports what the failure of that was.
        const refused = deps({
            listen: async () => {
                throw REFUSED;
            },
        });
        const actor = createActor(sessionMachine, { input: refused.deps }).start();
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ feed: "failed" })).toBe(true));
        expect(actor.getSnapshot().context.error?.message).toBe("the bus refused the listener");
    });

    it("writes what a record carries, and takes the usage of the stream as it is reported", () => {
        const { applied } = after([
            record("message_start", { message: assistantMessage(2) }),
            record("message_update", {
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
                usage: usage(),
            }),
        ]);
        expect(applied.map((each) => each.record.type)).toEqual(["message_start", "message_update"]);
        expect(applied.every((each) => each.drawing)).toBe(true);
    });
});

function user(timestamp: number) {
    return { role: "user" as const, content: "hello", timestamp };
}

function assistantMessage(timestamp: number) {
    return { ...assistant([], { stopReason: "pending" }), timestamp };
}
