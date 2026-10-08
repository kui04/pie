import { getShortestPaths } from "@xstate/graph";
import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { sessionMachine, type SessionEvent } from "@/machines/session.machine";

/** An actor with `events` sent in order, the way the listeners and the read deliver them. */
function after(events: SessionEvent[]) {
    const actor = createActor(sessionMachine).start();
    for (const event of events) actor.send(event);
    return actor;
}

const everyEvent: SessionEvent[] = [
    { type: "LISTENING" },
    { type: "STATE_READ", streaming: true },
    { type: "STATE_READ", streaming: false },
    { type: "RUN_STARTED" },
    { type: "RUN_ENDED", willRetry: true },
    { type: "RUN_ENDED", willRetry: false },
    { type: "SETTLED" },
];

describe("the run of a session", () => {
    it("starts idle, before anything is read or heard", () => {
        expect(after([]).getSnapshot().matches("idle")).toBe(true);
    });

    it("reads the run of a screen that mounted in the middle of one", () => {
        // The listeners open after the run began, so no `agent_start` arrives for
        // it: the read of the state is all this screen gets.
        expect(
            after([{ type: "LISTENING" }, { type: "STATE_READ", streaming: true }])
                .getSnapshot()
                .matches("working"),
        ).toBe(true);
        expect(
            after([{ type: "LISTENING" }, { type: "STATE_READ", streaming: false }])
                .getSnapshot()
                .matches("idle"),
        ).toBe(true);
    });

    it("keeps a run event over a read that was answered before it", () => {
        // The read is older than the event and arrives later. It must not end a run
        // that just started.
        expect(
            after([{ type: "RUN_STARTED" }, { type: "STATE_READ", streaming: false }])
                .getSnapshot()
                .matches("working"),
        ).toBe(true);
        // And the other way: a read of a running session cannot hold a run that ended.
        expect(
            after([
                { type: "STATE_READ", streaming: true },
                { type: "RUN_ENDED", willRetry: false },
            ])
                .getSnapshot()
                .matches("idle"),
        ).toBe(true);
    });

    it("keeps working while pi retries, and is idle only when the session settles", () => {
        expect(
            after([{ type: "RUN_STARTED" }, { type: "RUN_ENDED", willRetry: true }])
                .getSnapshot()
                .matches("working"),
        ).toBe(true);
        expect(
            after([{ type: "RUN_STARTED" }, { type: "RUN_ENDED", willRetry: true }, { type: "SETTLED" }])
                .getSnapshot()
                .matches("idle"),
        ).toBe(true);
    });

    it("is idle at once when a run ends without a retry", () => {
        expect(
            after([{ type: "RUN_STARTED" }, { type: "RUN_ENDED", willRetry: false }])
                .getSnapshot()
                .matches("idle"),
        ).toBe(true);
    });

    it("makes the next read the authority after the listeners open again", () => {
        // The listeners were closed and the records in between are gone. The event
        // before the re-open may not decide what the session is doing now.
        const stale = after([{ type: "RUN_STARTED" }, { type: "STATE_READ", streaming: false }]);
        expect(stale.getSnapshot().matches("working")).toBe(true);

        stale.send({ type: "LISTENING" });
        stale.send({ type: "STATE_READ", streaming: false });
        expect(stale.getSnapshot().matches("idle")).toBe(true);
    });

    it("reaches both states on every graph-enumerated shortest path", () => {
        for (const target of ["idle", "working"] as const) {
            const paths = getShortestPaths(sessionMachine, {
                events: everyEvent,
                toState: (state) => state.matches(target),
            });
            expect(paths.length, `no path to ${target}`).toBeGreaterThan(0);

            for (const path of paths) {
                const actor = createActor(sessionMachine).start();
                for (const step of path.steps) actor.send(step.event);
                expect(actor.getSnapshot().matches(target), `a path to ${target} landed elsewhere`).toBe(true);
            }
        }
    });
});
