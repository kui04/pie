/**
 * The registry of session charts: one actor per session, counted by the screens that hold
 * it. Nothing here talks to pi - the actors do that through their deps.
 */

import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { SessionEntry } from "@/lib/rpc-protocol";
import { ensureSession, forgetSession, sessionOf, type SessionRef } from "@/lib/sessions";
import { user } from "@/preview/fixtures";

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    log: { ...(await importOriginal<typeof Bridge>()).log, debug: vi.fn(), warn: vi.fn() },
    onSessionEvent: vi.fn(async () => () => undefined),
    onSessionState: vi.fn(async () => () => undefined),
}));

const A = "main:1";
const B = "main:2";

let client: QueryClient;

/** The hands a test took, so that the end of it gives back every one of them. */
const held = new Map<string, number>();

/** Takes one hand on the chart of a session, as a screen does when it mounts. */
function hold(session: string): void {
    ensureSession(session, client);
    held.set(session, (held.get(session) ?? 0) + 1);
}

/** Waits until the listeners of a chart opened the feed: a record draws only there. */
async function live(actor: SessionRef | null): Promise<void> {
    await vi.waitFor(() => expect(actor?.getSnapshot().value).toMatchObject({ feed: "live" }));
}

beforeEach(() => {
    client = new QueryClient();
    held.clear();
});

afterEach(async () => {
    // A slot that a test left behind would answer the next test's `ensureSession` with a
    // chart of its own.
    for (const [session, count] of held) {
        for (let hand = 0; hand < count; hand += 1) forgetSession(session);
    }
    held.clear();
    await Promise.resolve();
});

describe("the charts of the sessions", () => {
    it("answers the same chart for a second hand on one session", () => {
        hold(A);
        const first = sessionOf(A);

        hold(A);

        expect(sessionOf(A)).toBe(first);
    });

    it("keeps the two sessions apart", async () => {
        hold(A);
        hold(B);
        const a = sessionOf(A);
        const b = sessionOf(B);
        expect(a).not.toBe(b);
        await live(a);
        await live(b);

        b?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } });

        expect(b?.getSnapshot().value).toMatchObject({ run: "waiting" });
        expect(a?.getSnapshot().value).toMatchObject({ run: "idle" });
    });

    it("stops the chart of a session at the last hand, and not the other session's", async () => {
        hold(A);
        hold(B);
        const a = sessionOf(A);

        forgetSession(A);
        held.delete(A);
        await Promise.resolve();

        expect(sessionOf(A)).toBeNull();
        expect(sessionOf(B)).not.toBeNull();
        expect(a?.getSnapshot().status).toBe("stopped");
    });

    it("keeps the chart when a hand comes back in the same task, as a double mount does", async () => {
        // React's StrictMode runs the effects of a mount twice: start, stop, start. The
        // chart is what the whole screen waits on, so the stop waits for the task to end.
        hold(A);
        const first = sessionOf(A);

        forgetSession(A);
        hold(A);

        expect(sessionOf(A)).toBe(first);
        expect(first?.getSnapshot().status).toBe("active");
        await Promise.resolve();

        expect(first?.getSnapshot().status).toBe("active");
    });

    it("drops a record that arrives after the chart was stopped, without a throw", async () => {
        hold(A);
        const actor = sessionOf(A);
        forgetSession(A);
        held.delete(A);
        await Promise.resolve();

        expect(actor?.getSnapshot().status).toBe("stopped");
        expect(() => actor?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } })).not.toThrow();
        expect(actor?.getSnapshot().value).toMatchObject({ run: "idle" });
    });

    it("hands a record of one session to that session alone", async () => {
        hold(A);
        hold(B);
        await live(sessionOf(A));
        await live(sessionOf(B));
        const entry: SessionEntry = {
            type: "message",
            id: "e1",
            parentId: null,
            timestamp: "2026-10-05T00:00:00.000Z",
            message: user("hello"),
        };

        sessionOf(A)?.send({ type: "RECORD", at: 0, record: { type: "entry_appended", entry } });

        expect(sessionOf(A)?.getSnapshot().context.overlay.order).toEqual(["e1"]);
        expect(sessionOf(B)?.getSnapshot().context.overlay.order).toEqual([]);
    });
});

describe("the screen of a session under StrictMode", () => {
    it("holds one chart through the double mount, and gives it up when the screen goes", async () => {
        const seen: (SessionRef | null)[] = [];
        function Slot() {
            useEffect(() => {
                ensureSession(A, client);
                seen.push(sessionOf(A));
                return () => {
                    seen.push(sessionOf(A));
                    forgetSession(A);
                };
            }, []);
            return null;
        }

        const screen = render(
            <StrictMode>
                <Slot />
            </StrictMode>,
        );

        // StrictMode starts the effect, stops it and starts it again: the second start finds
        // the chart the first one left, the transcript and the run with it.
        expect(seen).toHaveLength(3);
        expect(seen.every((chart) => chart === seen[0])).toBe(true);
        expect(sessionOf(A)).toBe(seen[0]);

        screen.unmount();
        await Promise.resolve();

        expect(sessionOf(A)).toBeNull();
    });
});
