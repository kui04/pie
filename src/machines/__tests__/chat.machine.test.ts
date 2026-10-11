import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import { chatMachine, errorOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";

/**
 * The chart of the screen: which conversation the window shows, and whether it
 * has arrived. Nothing of the session itself is here - the feed, the run and the
 * switch belong to `session.machine.ts` - so these tests drive events only.
 *
 * Starting pi is a step of this flow, so the attach arrives as a dep: a test says
 * whether it answers or fails, and needs no Tauri runtime.
 */

function started(attach: ChatDeps["attach"] = async () => {}) {
    const actor = createActor(chatMachine, { input: { attach } }).start();
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

    it("starts pi when the connection holds none, and lands when it answers", async () => {
        let attached = 0;
        const actor = started(async () => {
            attached += 1;
        });

        actor.send({ type: "ATTACH" });

        expect(stageOf(actor.getSnapshot())).toBe("attaching");
        await vi.waitFor(() => expect(attached).toBe(1));
        // The attach itself leaves no page: the read of the connection shows the
        // session next, and that is what the landing waits for.
        expect(stageOf(actor.getSnapshot())).toBe("attaching");

        actor.send({ type: "HELD" });

        expect(stageOf(actor.getSnapshot())).toBe("landing");
        expect(errorOf(actor.getSnapshot())).toBeNull();
    });

    it("starts nothing when a session already speaks", () => {
        // A reload of the webview: Rust holds the pi of the connection, and the
        // read shows it before the actor of `attaching` ever runs.
        let attached = 0;
        const actor = started(async () => {
            attached += 1;
        });

        actor.send({ type: "HELD" });

        expect(stageOf(actor.getSnapshot())).toBe("landing");
        expect(attached).toBe(0);
    });

    it("says why pi could not be started, and tries again", async () => {
        let attempts = 0;
        const actor = started(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("no pi on PATH");
        });

        actor.send({ type: "ATTACH" });
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("unattached"));
        expect(errorOf(actor.getSnapshot())?.message).toBe("no pi on PATH");

        actor.send({ type: "RETRY" });

        expect(stageOf(actor.getSnapshot())).toBe("attaching");
        expect(errorOf(actor.getSnapshot())).toBeNull();
        await vi.waitFor(() => expect(attempts).toBe(2));
    });
});
