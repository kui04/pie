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

        expect(stageOf(actor.getSnapshot())).toBe("loading");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");

        actor.send({ type: "ARRIVED" });

        expect(stageOf(actor.getSnapshot())).toBe("loaded");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");
    });

    it("hands the window back to the loading page on a switch", () => {
        // A switch is the same passage as an open: the loaded page is given up, and
        // the page that says a conversation is coming stands in its place.
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });
        actor.send({ type: "ARRIVED" });

        actor.send({ type: "SWITCH" });

        expect(stageOf(actor.getSnapshot())).toBe("loading");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");

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

        expect(stageOf(actor.getSnapshot())).toBe("loading");
        expect(sessionOf(actor.getSnapshot())).toBe("main:1");
    });

    it("does not switch a conversation that has not arrived", () => {
        const actor = started();
        actor.send({ type: "OPEN", session: "main:1" });

        actor.send({ type: "SWITCH" });

        expect(sessionOf(actor.getSnapshot())).toBe("main:1");
        expect(stageOf(actor.getSnapshot())).toBe("loading");
    });
});
