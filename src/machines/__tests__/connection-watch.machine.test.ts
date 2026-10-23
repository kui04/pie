/**
 * The graph of the reach to the machine: what an ended link does to the window, and what a
 * person can do about it.
 *
 * The dial is a dep, so a test says what it answers and needs no Tauri runtime. The clock
 * travels in the events, as in `session.machine.ts`: an action that read it would write a
 * different context for the same event, and `@xstate/graph` keys a node by its context.
 */

import { createActor } from "xstate";
import { getShortestPaths } from "@xstate/graph";
import { describe, expect, it, vi } from "vitest";
import { connectionWatchMachine, type ConnectionWatchDeps } from "@/machines/connection-watch.machine";

function started(overrides: Partial<ConnectionWatchDeps> = {}) {
    const dials: string[] = [];
    const actor = createActor(connectionWatchMachine, {
        input: {
            reconnect: async () => {
                dials.push("dial");
            },
            ...overrides,
        },
    }).start();
    return { actor, dials };
}

/**
 * The states an event leads to. `held` is where the machine starts, and `failed` is reached by
 * a dial that a dep rejects, which the walk's own dep never does: both are covered by the
 * behaviour tests above.
 */
const STATES = ["lost", "retrying", "left"] as const;

const EVERY_EVENT = [
    { type: "LOST", at: 5 } as const,
    { type: "RETRY" } as const,
    { type: "RESTORED", at: 6 } as const,
    { type: "LEAVE" } as const,
];

describe("the reach to the machine", () => {
    it("holds a live connection, and says nothing", () => {
        const { actor } = started();

        expect(actor.getSnapshot().value).toBe("held");
        expect(actor.getSnapshot().context.message).toBeNull();
    });

    it("goes to the lost state when Rust says the reach ended", () => {
        const { actor } = started();

        actor.send({ type: "LOST", at: 1_000 });

        expect(actor.getSnapshot().value).toBe("lost");
        expect(actor.getSnapshot().context.lostAt).toBe(1_000);
    });

    it("brings the connection back on a press, and clears what failed before", async () => {
        const { actor, dials } = started();
        actor.send({ type: "LOST", at: 1_000 });

        actor.send({ type: "RETRY" });

        expect(actor.getSnapshot().value).toBe("retrying");
        await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("held"));
        expect(dials).toHaveLength(1);
        expect(actor.getSnapshot().context.message).toBeNull();
    });

    it("will not stack a second dial on one that is already running", async () => {
        let finish: (() => void) | undefined;
        const { actor, dials } = started({
            reconnect: () =>
                new Promise<void>((resolve) => {
                    dials.push("dial");
                    finish = resolve;
                }),
        });
        actor.send({ type: "LOST", at: 1_000 });

        actor.send({ type: "RETRY" });
        actor.send({ type: "RETRY" });
        actor.send({ type: "RETRY" });

        expect(dials).toHaveLength(1);
        finish?.();
        await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("held"));
    });

    it("keeps the sentence of a dial that failed, and stays able to try again", async () => {
        const { actor } = started({
            reconnect: async () => {
                throw { kind: "failed", message: "the host never answered" };
            },
        });
        actor.send({ type: "LOST", at: 1_000 });

        actor.send({ type: "RETRY" });

        await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("failed"));
        expect(actor.getSnapshot().context.message).toBe("the host never answered");

        // The offer is still there: a reach stays lost until a dial answers, and a dial may
        // fail for a network that is still down.
        actor.send({ type: "RETRY" });
        expect(actor.getSnapshot().value).toBe("retrying");
    });

    it("refuses a read that answered before the reach ended", () => {
        const { actor } = started();
        actor.send({ type: "LOST", at: 1_000 });

        actor.send({ type: "RESTORED", at: 1_000 });
        expect(actor.getSnapshot().value).toBe("lost");

        actor.send({ type: "RESTORED", at: 999 });
        expect(actor.getSnapshot().value).toBe("lost");

        actor.send({ type: "RESTORED", at: 1_001 });
        expect(actor.getSnapshot().value).toBe("held");
    });

    it("leaves for the gate, and comes back when a dial answers", () => {
        const { actor } = started();
        actor.send({ type: "LOST", at: 1_000 });

        actor.send({ type: "LEAVE" });
        expect(actor.getSnapshot().value).toBe("left");

        actor.send({ type: "RESTORED", at: 1_001 });
        expect(actor.getSnapshot().value).toBe("held");
    });

    it("reaches every state of its own graph", () => {
        for (const state of STATES) {
            const paths = getShortestPaths(connectionWatchMachine, {
                events: EVERY_EVENT,
                input: { reconnect: async () => undefined },
                toState: (snapshot) => snapshot.matches(state),
            });
            expect(paths.length, `no path to ${state}`).toBeGreaterThan(0);
        }
    });
});
