import { getShortestPaths } from "@xstate/graph";
import { assign, createActor, createMachine } from "xstate";
import { describe, expect, it } from "vitest";

// The pattern every machine in src/machines/ follows: direct actor tests
// (Arrange-Act-Assert) plus @xstate/graph path replay for transition coverage.

const approvalMachine = createMachine({
    id: "approval",
    initial: "awaiting",
    states: {
        awaiting: {
            on: {
                approve: { target: "approved" },
                reject: { target: "rejected" },
                cancel: { target: "cancelled" },
            },
        },
        approved: { type: "final" },
        rejected: { type: "final" },
        cancelled: { type: "final" },
    },
});

describe("approvalMachine", () => {
    it("transitions to the decided state", () => {
        const actor = createActor(approvalMachine).start();

        expect(actor.getSnapshot().matches("awaiting")).toBe(true);
        actor.send({ type: "approve" });

        expect(actor.getSnapshot().matches("approved")).toBe(true);
    });

    it("reaches `approved` on every graph-enumerated shortest path", () => {
        const paths = getShortestPaths(approvalMachine, {
            events: [{ type: "approve" }, { type: "reject" }, { type: "cancel" }],
            toState: (state) => state.matches("approved"),
        });
        expect(paths.length).toBeGreaterThan(0);

        for (const path of paths) {
            const actor = createActor(approvalMachine).start();
            for (const step of path.steps) {
                actor.send(step.event);
            }
            expect(actor.getSnapshot().matches("approved")).toBe(true);
        }
    });
});

// The two behaviors of the package that `session.machine.ts` stands on: an action reads the
// actor it runs in, and the snapshot it finds there is the one before the transition - which
// is what `draw` reads to know whether the feed is live as the record lands. Both are
// documented (and held by these tests, because ^5.33.2 may move under us) rather than
// guaranteed by the type system.
describe("xstate itself", () => {
    it("gives an action the actor it runs in, with the snapshot before the transition", () => {
        const seen: string[] = [];
        const machine = createMachine({
            initial: "a",
            states: {
                a: {
                    on: {
                        go: {
                            target: "b",
                            actions: [
                                ({ self }) => {
                                    seen.push(String(self.getSnapshot().value), self.id);
                                },
                            ],
                        },
                    },
                },
                b: {},
            },
        });
        const actor = createActor(machine).start();

        actor.send({ type: "go" });

        expect(seen).toEqual(["a", actor.id]);
    });

    it("lets an assign resolver read that actor too, before the transition", () => {
        const machine = createMachine({
            context: { here: "" },
            initial: "a",
            states: {
                a: {
                    on: {
                        go: {
                            target: "b",
                            actions: assign({ here: ({ self }) => String(self.getSnapshot().value) }),
                        },
                    },
                },
                b: {},
            },
        });
        const actor = createActor(machine).start();

        actor.send({ type: "go" });

        expect(actor.getSnapshot().context.here).toBe("a");
        expect(actor.getSnapshot().value).toBe("b");
    });

    it("runs the assigns of one transition in order, each over the context the one before wrote", () => {
        const machine = createMachine({
            context: { log: [] as string[] },
            initial: "a",
            states: {
                a: {
                    on: {
                        go: {
                            target: "b",
                            actions: [
                                assign({ log: ({ context }) => [...context.log, "first"] }),
                                assign({ log: ({ context }) => [...context.log, "second"] }),
                            ],
                        },
                    },
                },
                b: {},
            },
        });
        const actor = createActor(machine).start();

        actor.send({ type: "go" });

        expect(actor.getSnapshot().context.log).toEqual(["first", "second"]);
    });
});
