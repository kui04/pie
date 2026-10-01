import { getShortestPaths } from "@xstate/graph";
import { createActor, createMachine } from "xstate";
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
