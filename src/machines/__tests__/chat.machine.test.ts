import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import { chatMachine, errorOf, pathOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";

/**
 * The chart of the screen: which conversation the window shows, and the attach that opens
 * one. Nothing of the session itself is here - the feed, the transcript and the run belong
 * to `session.machine.ts` - so these tests drive events only.
 *
 * Starting pi is a step of this flow, so the attach arrives as a dep: a test says what it
 * answers, and needs no Tauri runtime.
 */

function started(overrides: Partial<ChatDeps> = {}) {
    const attached: string[] = [];
    const startedIn: (string | null)[] = [];
    const detached: string[] = [];
    let made = 0;
    const actor = createActor(chatMachine, {
        input: {
            attach: async (path) => {
                attached.push(path);
                made += 1;
                // A name that no test writes by hand, so the assertion can tell the session
                // the attach answered with from one that was already there.
                return { id: `made:${made}`, cwd: null };
            },
            start: async (cwd) => {
                startedIn.push(cwd);
                made += 1;
                return { id: `made:${made}`, cwd: null };
            },
            detach: async (session) => {
                detached.push(session);
            },
            ...overrides,
        },
    }).start();
    return { actor, attached, startedIn, detached };
}

describe("the chat's stages", () => {
    it("starts on the landing, with no session chosen", () => {
        const { actor } = started();

        expect(stageOf(actor.getSnapshot())).toBe("landing");
        expect(sessionOf(actor.getSnapshot())).toBeNull();
    });

    it("starts a new conversation in the home of the host, and views the session that answers", async () => {
        const { actor, attached, startedIn } = started();

        actor.send({ type: "ATTACH", cwd: null });

        expect(stageOf(actor.getSnapshot())).toBe("attaching");
        expect(pathOf(actor.getSnapshot())).toBeNull();
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("viewing"));
        // No path and no directory: pi starts in the home of the machine.
        expect(startedIn).toEqual([null]);
        expect(attached).toEqual([]);
        expect(sessionOf(actor.getSnapshot())).toBe("made:1");
    });

    it("starts a new conversation in the directory that was chosen", async () => {
        const { actor, startedIn } = started();

        actor.send({ type: "ATTACH", cwd: "/home/kui/Projects/pie" });

        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("viewing"));
        expect(startedIn).toEqual(["/home/kui/Projects/pie"]);
    });

    it("attaches on the conversation of a chosen file", async () => {
        const { actor, attached } = started();

        actor.send({ type: "FOCUS", path: "/sessions/one.jsonl" });

        expect(stageOf(actor.getSnapshot())).toBe("attaching");
        expect(pathOf(actor.getSnapshot())).toBe("/sessions/one.jsonl");
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("viewing"));
        // Pi reads the file itself: the path is what the attach is given.
        expect(attached).toEqual(["/sessions/one.jsonl"]);
    });

    it("views a session that already speaks, with no attach", () => {
        const { actor, attached } = started();

        actor.send({ type: "OPEN", session: "main:7" });

        expect(stageOf(actor.getSnapshot())).toBe("viewing");
        expect(sessionOf(actor.getSnapshot())).toBe("main:7");
        expect(attached).toEqual([]);
    });

    it("views the session that answered, and ends nothing", async () => {
        // A session is one process with one conversation: the pick attaches another one, and
        // the process that was in view keeps running - it is another session of the same
        // connection, and only a close ends one.
        const { actor, detached } = started();
        actor.send({ type: "OPEN", session: "main:1" });

        actor.send({ type: "FOCUS", path: "/sessions/two.jsonl" });
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("viewing"));

        expect(sessionOf(actor.getSnapshot())).toBe("made:1");
        expect(detached).toEqual([]);
    });

    it("attaches on the file that was picked, and keeps the session that was in view", async () => {
        // The landing after a reload: the connection still holds a pi. A pick of another file
        // attaches a session on it; the held process is a session of its own.
        const { actor, attached, detached } = started();
        actor.send({ type: "FOCUS", path: "/sessions/three.jsonl" });
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("viewing"));

        expect(attached).toEqual(["/sessions/three.jsonl"]);
        expect(detached).toEqual([]);
        expect(sessionOf(actor.getSnapshot())).toBe("made:1");
    });

    it("gives the conversation up when the screen is told to close it", () => {
        const { actor, detached } = started();
        actor.send({ type: "OPEN", session: "main:1" });

        actor.send({ type: "CLOSE" });

        expect(stageOf(actor.getSnapshot())).toBe("landing");
        expect(sessionOf(actor.getSnapshot())).toBeNull();
        expect(detached).toEqual(["main:1"]);
    });

    it("does not open another conversation while one is on its way", () => {
        const { actor } = started();
        actor.send({ type: "ATTACH", cwd: null });

        actor.send({ type: "OPEN", session: "main:2" });

        expect(stageOf(actor.getSnapshot())).toBe("attaching");
        expect(sessionOf(actor.getSnapshot())).toBeNull();
    });

    it("says why pi could not be started, and tries the same conversation again", async () => {
        let attempts = 0;
        const { actor, attached } = started({
            attach: async (path) => {
                attempts += 1;
                attached.push(path);
                if (attempts === 1) throw new Error("no pi on PATH");
                return { id: "main:1", cwd: null };
            },
        });

        actor.send({ type: "FOCUS", path: "/sessions/one.jsonl" });
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("unattached"));
        expect(errorOf(actor.getSnapshot())?.message).toBe("no pi on PATH");

        actor.send({ type: "RETRY" });

        expect(stageOf(actor.getSnapshot())).toBe("attaching");
        expect(errorOf(actor.getSnapshot())).toBeNull();
        await vi.waitFor(() => expect(stageOf(actor.getSnapshot())).toBe("viewing"));
        expect(attached).toEqual(["/sessions/one.jsonl", "/sessions/one.jsonl"]);
    });
});
