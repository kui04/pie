import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { chatMachine, sessionOf, stageOf } from "@/machines/chat.machine";

/**
 * The chart of the screen: which conversation the window shows, and whether it
 * has arrived. Nothing of the session itself is here - the feed, the run and the
 * switch belong to `session.machine.ts` - so these tests drive events only.
 */

function started() {
    const actor = createActor(chatMachine).start();
    return actor;
}

describe("the chat's stages", () => {
    it("starts on the landing, with no session chosen", () => {
        const actor = started();

        expect(stageOf(actor.getSnapshot())).toBe("landing");
        expect(sessionOf(actor.getSnapshot())).toBeNull();
    });

    it("opens the session that was picked, and holds it once it arrives", () => {
        const actor = started();

        actor.send({ type: "OPEN", session: "main:1" });

        expect(stageOf(actor.getSnapshot())).toBe("opening");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");

        actor.send({ type: "ARRIVED" });

        expect(stageOf(actor.getSnapshot())).toBe("loaded");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");
    });

    it("says a feed never opened, and opens it again on a retry", () => {
        // Nothing of that session is on screen while its feed cannot open, so the
        // window says what happened and offers another try rather than guessing.
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });

        actor.send({ type: "FAILED" });

        expect(stageOf(actor.getSnapshot())).toBe("failed");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");

        actor.send({ type: "RETRY" });

        expect(stageOf(actor.getSnapshot())).toBe("opening");
    });

    it("keeps the conversation on screen when a switch fails", () => {
        // Pi still holds the conversation that was on screen: a switch that failed
        // left it alone, so the window stays with it.
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });
        actor.send({ type: "ARRIVED" });

        actor.send({ type: "SWITCH" });
        expect(stageOf(actor.getSnapshot())).toBe("switching");

        actor.send({ type: "FAILED" });
        expect(stageOf(actor.getSnapshot())).toBe("loaded");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");
    });

    it("shows the conversation a switch moved to", () => {
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });
        actor.send({ type: "ARRIVED" });
        actor.send({ type: "SWITCH" });

        actor.send({ type: "ARRIVED" });

        expect(stageOf(actor.getSnapshot())).toBe("loaded");
    });

    it("gives the conversation up when the screen is told to close it", () => {
        // `Detach` is not built yet; the chart already holds the edge it will use.
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });
        actor.send({ type: "ARRIVED" });

        actor.send({ type: "CLOSE" });

        expect(stageOf(actor.getSnapshot())).toBe("landing");
        expect(sessionOf(actor.getSnapshot())).toBeNull();
    });

    it("does not open a second conversation while one is on its way", () => {
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });

        actor.send({ type: "OPEN", session: "main:2" });

        expect(stageOf(actor.getSnapshot())).toBe("opening");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");
    });
});
