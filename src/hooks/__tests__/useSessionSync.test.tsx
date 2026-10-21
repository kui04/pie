/**
 * The charts of the sessions follow the connection, not the screen: this is the effect that
 * keeps them in step, and the phases a list lights its rows by.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { ConnectionInfo } from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { forgetSession, phases, sessionOf } from "@/lib/session";
import { useSessionSync } from "@/hooks/useSessionSync";

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    log: { ...(await importOriginal<typeof Bridge>()).log, debug: vi.fn(), warn: vi.fn() },
    getConnection: vi.fn<() => Promise<ConnectionInfo | null>>(),
    onSessionEvent: vi.fn(async () => () => undefined),
    onSessionState: vi.fn(async () => () => undefined),
}));

const bridge = vi.mocked(await import("@/lib/bridge"));

/** The connection the workspace reads: one machine, and the sessions it holds. */
function connected(sessions: string[]): ConnectionInfo {
    return {
        id: "main",
        endpoint: "local",
        sessions: sessions.map((id) => ({ id, cwd: null })),
        open: true,
    };
}

let client: QueryClient;

beforeEach(() => {
    client = new QueryClient(queryDefaults);
    vi.clearAllMocks();
    bridge.onSessionEvent.mockResolvedValue(() => undefined);
    bridge.onSessionState.mockResolvedValue(() => undefined);
});

afterEach(() => {
    // A test is a window of its own: its charts go with it.
    for (const session of [...phases().keys()]) forgetSession(session);
});

describe("the sessions of the connection", () => {
    it("starts a chart for every session the connection holds, and follows it as it changes", async () => {
        bridge.getConnection.mockResolvedValue(connected(["main:1", "main:2"]));
        render(
            <QueryClientProvider client={client}>
                <Sync />
            </QueryClientProvider>,
        );

        await vi.waitFor(() => expect(sessionOf("main:1")).not.toBeNull());
        expect(sessionOf("main:2")).not.toBeNull();

        // The connection that comes after this one holds another session, and nothing else.
        bridge.getConnection.mockResolvedValue(connected(["main:2"]));
        await client.invalidateQueries({ queryKey: ["connection"] });

        await vi.waitFor(() => expect(sessionOf("main:1")).toBeNull());
        expect(sessionOf("main:2")).not.toBeNull();
    });

    it("keeps what it holds while the connection is not read yet", () => {
        // A read on its way says nothing about the sessions: a reload must not end a run
        // because the window has not answered yet.
        bridge.getConnection.mockReturnValue(new Promise(() => undefined));
        render(
            <QueryClientProvider client={client}>
                <Sync />
            </QueryClientProvider>,
        );

        expect(sessionOf("main:1")).toBeNull();
        expect(phases().size).toBe(0);
    });

    it("forgets every chart when the connection is gone", async () => {
        bridge.getConnection.mockResolvedValue(connected(["main:1"]));
        render(
            <QueryClientProvider client={client}>
                <Sync />
            </QueryClientProvider>,
        );
        await vi.waitFor(() => expect(sessionOf("main:1")).not.toBeNull());

        bridge.getConnection.mockResolvedValue(null);
        await client.invalidateQueries({ queryKey: ["connection"] });

        await vi.waitFor(() => expect(sessionOf("main:1")).toBeNull());
    });
});

function Sync() {
    useSessionSync();
    return null;
}
