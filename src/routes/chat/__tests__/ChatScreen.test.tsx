import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { MODULE_REASON } from "@/lib/failure-text";
import { ChatScreen } from "@/routes/chat/ChatScreen";
import { useTranscriptStore } from "@/stores/transcript.store";
import { chain, messageEntry, sessionStats, storeOf, user } from "@/preview/fixtures";

type Call = () => Promise<unknown>;
type Listen = () => Promise<() => void>;

const bridge = vi.hoisted(() => ({
    getConnection: vi.fn<Call>(),
    getState: vi.fn<Call>(),
    getEntries: vi.fn<Call>(),
    getSessionStats: vi.fn<Call>(),
    onSessionEvent: vi.fn<Listen>(),
    onSessionState: vi.fn<Listen>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/**
 * The list draws by measurement, and this environment lays nothing out: every
 * ancestor reports a height of 0, whatever its style says, so the real list draws
 * no rows at all and a test that went through it would hold nothing of what a
 * reader sees. The rows are drawn here instead, and the list's own behaviour -
 * following the end, the jump pill - is out of scope of this file.
 */
vi.mock("virtua", () => ({
    VList: ({ data, children, id }: { data: unknown[]; children: (row: unknown) => ReactNode; id?: string }) => (
        <div id={id}>{data.map(children)}</div>
    ),
}));

const CONNECTED = {
    id: "main",
    endpoint: { kind: "local" },
    sessions: [{ id: "main:1", cwd: "/home/kui04/work" }],
};

/**
 * The rows of the transcript are drawn by a list that measures itself, and this
 * environment does not lay anything out: the height has to be in a style, where
 * the list can read it, or it draws nothing.
 *
 * The screen reads its connection through TanStack Query and its landing links
 * to the gate, so it needs a client above it and a router around it - the same
 * two things the app's own mounting gives it.
 */
function renderScreen() {
    const client = new QueryClient();
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
                    <ChatScreen />
                </div>
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    useTranscriptStore.getState().clear();
    bridge.onSessionEvent.mockResolvedValue(() => undefined);
    bridge.onSessionState.mockResolvedValue(() => undefined);
    bridge.getState.mockResolvedValue({});
    bridge.getSessionStats.mockResolvedValue(sessionStats());
    bridge.getEntries.mockResolvedValue({ entries: [], leafId: null });
});

describe("ChatScreen", () => {
    it("offers the way back to the gate when no connection is held", async () => {
        bridge.getConnection.mockResolvedValue(null);

        renderScreen();

        expect(await screen.findByText("Open a session")).toBeInTheDocument();
        expect(await screen.findByText("This window is not connected to a host.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/");
    });

    it("says a session is empty rather than showing nothing", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = renderScreen();

        expect(await screen.findByText("Nothing has been said yet.")).toBeInTheDocument();
        expect(container.querySelector("#transcript-list")).toBeNull();
    });

    it("draws the transcript of the session of the connection", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        const entries = chain(messageEntry(user("make the parser skip empty lines")));
        bridge.getEntries.mockResolvedValue(storeOfEntries(entries));

        renderScreen();

        // The row itself is what is asserted: a screen that wired the store to a
        // list, and lost the entries between them, would still draw the list.
        expect(await screen.findByText("make the parser skip empty lines")).toBeInTheDocument();
    });

    it("says which failure stopped the read", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockRejectedValue({
            type: "connection",
            message: "this connection has no session `main:1`",
            error: { kind: "unknown_session" },
        });

        renderScreen();

        await waitFor(() =>
            expect(screen.getByText("That session is gone from this connection. Connect again.")).toBeInTheDocument(),
        );
    });

    it("has something to say about a failure it cannot name", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockRejectedValue({
            type: "rpc",
            message: "raw",
            error: { kind: "a_kind_of_a_later_pi" },
        });

        renderScreen();

        // The table names the failures of this screen; a name it does not know
        // falls back to the sentence of the module that owned it.
        await waitFor(() => expect(screen.getByRole("alert")).not.toHaveTextContent("a_kind_of_a_later_pi"));
        expect(screen.getByRole("alert")).toHaveTextContent(MODULE_REASON.rpc);
    });

    it("blames the listeners before the reads when both failed", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.onSessionEvent.mockRejectedValue({ type: "rpc", message: "raw", error: { kind: "closed" } });
        bridge.getEntries.mockRejectedValue({
            type: "connection",
            message: "raw",
            error: { kind: "unknown_session" },
        });

        renderScreen();

        // A read that failed while the pipe is closed says nothing new: the screen
        // offers the failure that explains the other one.
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The connection to pi ended."));
    });

    it("opens the listeners again when the reader asks for another try", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.onSessionEvent.mockRejectedValueOnce({ type: "rpc", message: "raw", error: { kind: "closed" } });
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("hello again")))));

        renderScreen();

        const alert = await screen.findByRole("alert");
        fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

        // A subscription is not held in a cache, so no invalidation can rebuild
        // it: the retry has to ask the hook for the listeners of this session.
        await waitFor(() => expect(bridge.onSessionEvent).toHaveBeenCalledTimes(2));
        expect(await screen.findByText("hello again")).toBeInTheDocument();
    });
});

/** The snapshot shape of a read, from a chain of entries. */
function storeOfEntries(entries: ReturnType<typeof chain> = []) {
    const store = storeOf(entries);
    return { entries, leafId: store.order.length > 0 ? store.order[store.order.length - 1] : null };
}
