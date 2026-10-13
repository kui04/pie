/**
 * The match a pick needs: which conversation a running session holds, and whether that session
 * works now - the light of a row of the list.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { SessionInfo } from "@/lib/bridge";
import { queryDefaults, sessionKeys } from "@/lib/query";
import type { SessionState } from "@/lib/rpc-protocol";
import { forgetSession, phases, sessionOf, syncSessions } from "@/lib/sessions";
import { useAttachedConversations } from "@/hooks/use-attached-conversations";
import { sessionState } from "@/preview/fixtures";

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    log: { ...(await importOriginal<typeof Bridge>()).log, debug: vi.fn(), warn: vi.fn() },
    getState: vi.fn<(session: string) => Promise<SessionState>>(),
    onSessionEvent: vi.fn(async () => () => undefined),
    onSessionState: vi.fn(async () => () => undefined),
}));

const bridge = vi.mocked(await import("@/lib/bridge"));

const SESSIONS: SessionInfo[] = [
    { id: "main:1", cwd: null },
    { id: "main:2", cwd: null },
];

let client: QueryClient;

beforeEach(() => {
    client = new QueryClient(queryDefaults);
    vi.clearAllMocks();
    bridge.onSessionEvent.mockResolvedValue(() => undefined);
    bridge.onSessionState.mockResolvedValue(() => undefined);
    // Each session holds a file of its own: the match is by that path, not by the id.
    bridge.getState.mockImplementation(async (session) =>
        sessionState({ sessionFile: `/sessions/${session.replace(":", "-")}.jsonl` }),
    );
});

afterEach(() => {
    // A test is a window of its own: its charts go with it.
    for (const session of [...phases().keys()]) forgetSession(session);
});

describe("the attached conversations", () => {
    const MINE = "/sessions/main-1.jsonl";
    const OTHER = "/sessions/main-2.jsonl";

    it("matches the file each session holds, and takes the phase from its chart", async () => {
        syncSessions(["main:1", "main:2"], client);
        const shown = renderAttached();

        await vi.waitFor(() => expect(shown.reads().size).toBe(2));
        expect(shown.reads().get(MINE)).toEqual({ session: "main:1", working: false });
        expect(shown.reads().get(OTHER)).toEqual({ session: "main:2", working: false });

        // A run of a session that is not on screen lights its row: the chart keeps the phase
        // of the records as they arrive, and no read of this hook is involved.
        sessionOf("main:1")?.send({ type: "RECORD", at: 0, record: { type: "agent_start" } });

        await vi.waitFor(() => expect(shown.reads().get(MINE)?.working).toBe(true));
        expect(shown.reads().get(OTHER)?.working).toBe(false);
    });

    it("matches nothing until a session's own read answers", async () => {
        bridge.getState.mockReturnValue(new Promise(() => undefined));
        syncSessions(["main:1"], client);
        const shown = renderAttached();

        expect(shown.reads().size).toBe(0);
        expect(client.getQueryData(sessionKeys.state("main:1"))).toBeUndefined();
    });

    it("reads the state of each attached session once", async () => {
        syncSessions(
            SESSIONS.map((session) => session.id),
            client,
        );
        renderAttached();

        await vi.waitFor(() => expect(bridge.getState).toHaveBeenCalledTimes(2));
        expect(bridge.getState).toHaveBeenCalledWith("main:1");
        expect(bridge.getState).toHaveBeenCalledWith("main:2");
    });
});

/** The hook under a client, with the map it last derived. */
function renderAttached() {
    const reads: { current: ReadonlyMap<string, { session: string; working: boolean }> } = {
        current: new Map(),
    };
    function Attached() {
        reads.current = useAttachedConversations(SESSIONS);
        return null;
    }
    render(
        <QueryClientProvider client={client}>
            <Attached />
        </QueryClientProvider>,
    );
    return { reads: () => reads.current };
}
