/**
 * The charts of the sessions follow the connection, not the screen: this is the effect that
 * keeps them in step, and the phases a list lights its rows by.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { forgetSession, phases, sessionOf } from "@/lib/session";
import { conversation, sessionSummary } from "@/preview/fixtures";
import { useSessionSync } from "@/hooks/useSessionSync";

const fake = vi.hoisted(() => ({
    listSessions: vi.fn<() => Promise<Bridge.SessionInfo[]>>(),
    onSessionEvent: vi.fn(async () => () => undefined),
    onSessionEnded: vi.fn(async () => () => undefined),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    log: { ...(await importOriginal<typeof Bridge>()).log, debug: vi.fn(), warn: vi.fn() },
    ...fake,
}));

/** The conversations the machine holds, as the command answers them. */
function connected(sessions: string[]): Bridge.SessionInfo[] {
    return sessions.map((path) => sessionSummary({ path }));
}

const A = conversation({ session: "main:1" });
const B = conversation({ session: "main:2" });

let client: QueryClient;

beforeEach(() => {
    client = new QueryClient(queryDefaults);
    vi.clearAllMocks();
    fake.onSessionEvent.mockResolvedValue(() => undefined);
    fake.onSessionEnded.mockResolvedValue(() => undefined);
});

afterEach(() => {
    // A test is a window of its own: its charts go with it.
    for (const session of [...phases().keys()]) forgetSession(session);
});

function Sync() {
    useSessionSync();
    return null;
}

describe("the sessions of the connection", () => {
    it("starts a chart for every conversation the connection holds, and follows it", async () => {
        fake.listSessions.mockResolvedValue(connected(["main:1", "main:2"]));
        render(
            <QueryClientProvider client={client}>
                <Sync />
            </QueryClientProvider>,
        );

        await vi.waitFor(() => expect(sessionOf(A)).not.toBeNull());
        expect(sessionOf(B)).not.toBeNull();

        // The connection that comes after this one holds another conversation, and nothing else.
        fake.listSessions.mockResolvedValue(connected(["main:2"]));
        await client.invalidateQueries({ queryKey: ["connection"] });

        await vi.waitFor(() => expect(sessionOf(A)).toBeNull());
        expect(sessionOf(B)).not.toBeNull();
    });

    it("keeps what it holds while the connection is not read yet", () => {
        // A read on its way says nothing about the conversations: a reload must not end a run.
        expect(sessionOf(A)).toBeNull();
        forgetSession("main\u0000main:1");
        expect(phases().size).toBe(0);
    });

    it("forgets every chart when the connection is gone", async () => {
        fake.listSessions.mockResolvedValue(connected(["main:1"]));
        render(
            <QueryClientProvider client={client}>
                <Sync />
            </QueryClientProvider>,
        );
        await vi.waitFor(() => expect(sessionOf(A)).not.toBeNull());

        fake.listSessions.mockRejectedValue({ kind: "not_connected", message: "no connection" });
        await client.invalidateQueries({ queryKey: ["connection"] });

        await vi.waitFor(() => expect(sessionOf(A)).toBeNull());
    });
});
