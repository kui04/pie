/**
 * The registry of session charts: one actor per session the connection holds, started and
 * stopped by the list Rust answers with. Nothing here talks to pi - the actors do that through
 * their deps.
 */

import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { SessionEntry } from "@/lib/rpc-protocol";
import { forgetSession, phases, sessionOf, subscribeSessions, syncSessions, type SessionRef } from "@/lib/sessions";
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

beforeEach(() => {
    client = new QueryClient();
});

/** Waits until the listeners of a chart opened the feed: a record draws only there. */
async function live(actor: SessionRef | null): Promise<void> {
    await vi.waitFor(() => expect(actor?.getSnapshot().value).toMatchObject({ feed: "live" }));
}

describe("the charts of the sessions", () => {
    it("starts one chart per session of the connection, and forgets the rest", () => {
        syncSessions([A, B], client);
        const a = sessionOf(A);
        const b = sessionOf(B);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();

        // The connection that comes after this one holds another session, and nothing else.
        syncSessions([B], client);

        expect(sessionOf(A)).toBeNull();
        expect(sessionOf(B)).toBe(b);
    });

    it("keeps the chart of a session the list still names", async () => {
        // The sync runs on every change of the list, and StrictMode runs its effect twice:
        // the second run must find the charts the first one left, with their records in them.
        syncSessions([A], client);
        const a = sessionOf(A);
        await live(a);
        a?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } });

        syncSessions([A], client);

        expect(sessionOf(A)).toBe(a);
        expect(a?.getSnapshot().value).toMatchObject({ run: "waiting" });
    });

    it("forgets every chart when the connection is gone", () => {
        syncSessions([A, B], client);

        // A window that holds no connection holds no session: a chart speaks for a process
        // that is gone with it.
        syncSessions([], client);

        expect(sessionOf(A)).toBeNull();
        expect(sessionOf(B)).toBeNull();
    });

    it("reads the phase of every session it holds", async () => {
        const heard: string[] = [];
        const stop = subscribeSessions(() => heard.push("changed"));
        syncSessions([A, B], client);
        await live(sessionOf(A));

        expect(phases().get(A)).toBe("idle");
        expect(phases().get(B)).toBe("idle");

        sessionOf(A)?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } });

        // A run that continues while the session is off screen still lights its row.
        expect(phases().get(A)).toBe("waiting");
        expect(heard.length).toBeGreaterThan(0);

        forgetSession(A);
        expect(phases().has(A)).toBe(false);
        expect(phases().get(B)).toBe("idle");
        stop();
    });

    it("keeps the two sessions apart", async () => {
        syncSessions([A, B], client);
        await live(sessionOf(A));
        await live(sessionOf(B));

        sessionOf(B)?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } });

        expect(sessionOf(B)?.getSnapshot().value).toMatchObject({ run: "waiting" });
        expect(sessionOf(A)?.getSnapshot().value).toMatchObject({ run: "idle" });
    });

    it("drops a record that arrives after the chart was stopped, without a throw", () => {
        syncSessions([A], client);
        const actor = sessionOf(A);

        forgetSession(A);

        expect(actor?.getSnapshot().status).toBe("stopped");
        expect(() => actor?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } })).not.toThrow();
        expect(actor?.getSnapshot().value).toMatchObject({ run: "idle" });
    });

    it("hands a record of one session to that session alone", async () => {
        syncSessions([A, B], client);
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

describe("the sync of a connection under StrictMode", () => {
    it("finds the same charts when the effect runs twice", () => {
        const seen: (SessionRef | null)[] = [];
        function Sync() {
            useEffect(() => {
                // The connection effect of `useSessionSync.ts`, without the query: one run
                // per mount, and no cleanup - leaving the screen does not end a session.
                syncSessions([A, B], client);
                seen.push(sessionOf(A), sessionOf(B));
            }, []);
            return null;
        }

        const screen = render(
            <StrictMode>
                <Sync />
            </StrictMode>,
        );

        expect(seen).toHaveLength(4);
        // The second run finds the charts of the first, session by session.
        expect(seen[0]).not.toBeNull();
        expect(seen[2]).toBe(seen[0]);
        expect(seen[3]).toBe(seen[1]);

        screen.unmount();
        expect(sessionOf(A)).not.toBeNull();

        // The tests of this file end here: the app ends its charts with the connection.
        syncSessions([], client);
        expect(sessionOf(A)).toBeNull();
    });
});
