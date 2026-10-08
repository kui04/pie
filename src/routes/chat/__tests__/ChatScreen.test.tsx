import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import type * as Bridge from "@/lib/bridge";
import type { SessionLifecycle } from "@/lib/bridge";
import type { Event } from "@/lib/protocol";
import { MODULE_REASON } from "@/lib/failure-text";
import { ChatScreen } from "@/routes/chat/ChatScreen";
import { useTranscriptStore } from "@/stores/transcript.store";
import { chain, messageEntry, sessionStats, sessionSummary, storeOf, user } from "@/preview/fixtures";

type Call = () => Promise<unknown>;
type ListenEvent = (session: string, handler: (payload: Event) => void) => Promise<() => void>;
type ListenState = (session: string, handler: (payload: SessionLifecycle) => void) => Promise<() => void>;

const bridge = vi.hoisted(() => ({
    getConnection: vi.fn<Call>(),
    getState: vi.fn<Call>(),
    getEntries: vi.fn<Call>(),
    getSessionStats: vi.fn<Call>(),
    listSessions: vi.fn<Call>(),
    switchSession: vi.fn<Call>(),
    clearQueue: vi.fn<Call>(),
    onSessionEvent: vi.fn<ListenEvent>(),
    onSessionState: vi.fn<ListenState>(),
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
 * A window of a stated width, and the way back to the real one.
 *
 * The workspace asks the width itself (the list is a panel of its own from `lg`),
 * and this environment answers one width for every query: without this, a test of
 * either shape would be a test of whichever the environment happens to report.
 */
function windowOf(width: "narrow" | "wide"): () => void {
    const list = {
        matches: width === "wide",
        media: "(min-width: 64rem)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(list);
    return () => vi.restoreAllMocks();
}

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
                {/* The toast stack belongs to the app; the workspace announces
                    what a switch could not do. */}
                <Toaster position="top-center" />
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
    bridge.listSessions.mockResolvedValue([]);
    bridge.clearQueue.mockResolvedValue({ steering: [], followUp: [] });
});

describe("ChatScreen", () => {
    it("offers the way back to the gate when no connection is held", async () => {
        bridge.getConnection.mockResolvedValue(null);

        renderScreen();

        expect(await screen.findByText("Open a session")).toBeInTheDocument();
        expect(await screen.findByText("This window is not connected to a host.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/");
    });

    it("gives the whole window to the chat when it is too narrow for a list", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = renderScreen();
        await screen.findByText("Nothing has been said yet.");

        expect(container.querySelector("#sidebar")).toBeNull();
        expect(container.querySelectorAll("#window")).toHaveLength(1);
        expect(container.querySelector("#chat")).not.toBeNull();
        restore();
    });

    it("holds the list in a sheet where the window is too narrow for a column", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        renderScreen();
        await screen.findByText("Nothing has been said yet.");

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        // The sheet carries the same list the column would.
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
        restore();
    });

    it("stands the list in a column of its own when the window holds one", async () => {
        const restore = windowOf("wide");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = renderScreen();
        await screen.findByText("Nothing has been said yet.");

        const sidebar = container.querySelector<HTMLElement>("#sidebar");
        expect(sidebar).not.toBeNull();
        expect(sidebar?.querySelector("#session-drawer")).not.toBeNull();
        // The column opens to its own width: the list is `w-64` and is clipped to
        // 256px, with the hairline it carries on the edge of that box.
        expect(sidebar?.style.width).toBe("256px");
        restore();
    });

    it("folds the column away from the bar's key, and gives the room back", async () => {
        const restore = windowOf("wide");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = renderScreen();
        await screen.findByText("Nothing has been said yet.");

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        await waitFor(() => expect(container.querySelector("#sidebar")).toBeNull());
        expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute("aria-expanded", "false");
        restore();
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

    it("keeps a queued prompt in the thread, and drops the queue when it is retracted", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());
        bridge.clearQueue.mockResolvedValue({ steering: ["run the tests first"], followUp: [] });

        renderScreen();
        // Wait for the session to be open first: opening one clears the store it reads
        // through, and the queue of a session arrives after that.
        await screen.findByText("Nothing has been said yet.");
        act(() => useTranscriptStore.getState().setQueue({ steering: ["run the tests first"], followUp: [] }));

        // A queued prompt is a row of the thread, below what was said.
        expect(await screen.findByText("run the tests first")).toBeInTheDocument();
        expect(screen.getByText("queued · steer")).toBeInTheDocument();

        fireEvent.contextMenu(screen.getByText("run the tests first"));
        fireEvent.click(await screen.findByText("Retract queued message"));

        await waitFor(() => expect(bridge.clearQueue).toHaveBeenCalledWith("main:1"));
    });

    it("moves the session to the conversation that was picked, and reads it again", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries
            .mockResolvedValueOnce(storeOfEntries(chain(messageEntry(user("first words")))))
            .mockResolvedValue(storeOfEntries(chain(messageEntry(user("the other conversation")))));
        const target = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([target]);
        bridge.switchSession.mockResolvedValue({ cancelled: false });

        renderScreen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        // The narrow window shows the list again as a sheet; the column is still
        // mounted behind it, so the row is searched inside the sheet.
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the row arrives with that read.
        fireEvent.click(await within(sheet).findByText("The other one"));

        // The path of the row is the one that is handed over: the workspace reads
        // the file, it builds no path of its own.
        await waitFor(() => expect(bridge.switchSession).toHaveBeenCalledWith("main:1", target.path));
        // Nothing of the new conversation arrives as an event, so the transcript is
        // read again - and the store is emptied first, so the words of the
        // conversation that was left are not on screen while it is read.
        expect(await screen.findByText("the other conversation")).toBeInTheDocument();
        expect(screen.queryByText("first words")).toBeNull();
        restore();
    });

    it("keeps the words on screen while an event has the read asked again", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        let ended: () => void = () => undefined;
        bridge.onSessionState.mockImplementation(async (_session, onState) => {
            ended = () => onState({ type: "ended", termination: { type: "exited", code: 0, success: true } });
            return () => undefined;
        });

        renderScreen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        // The pi of this session is gone, so the transcript is asked for again. Until
        // that read answers, the words that are already on screen stay: they are the
        // last thing that session said, which is what the reader is looking at.
        bridge.getEntries.mockReturnValue(new Promise(() => undefined));
        ended();

        await waitFor(() => expect(bridge.getEntries).toHaveBeenCalledTimes(2));
        expect(screen.getByText("first words")).toBeInTheDocument();
        expect(screen.queryByText("Opening the session…")).toBeNull();
    });

    it("sends one switch for two rows that are picked at the same instant", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        const first = sessionSummary({ name: "The first one" });
        const second = sessionSummary({ name: "The second one" });
        bridge.listSessions.mockResolvedValue([first, second]);
        // A host across a network answers when it answers, and until it does the
        // reader can pick another row; pi runs the commands of one session one after
        // another, so two switches would leave the conversation of whichever ends
        // last on screen.
        let answer: (data: unknown) => void = () => undefined;
        bridge.switchSession.mockReturnValue(new Promise((resolve) => (answer = resolve)));

        renderScreen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the rows arrive with that read.
        fireEvent.click(await within(sheet).findByText("The first one"));
        fireEvent.click(within(sheet).getByText("The second one"));

        expect(bridge.switchSession).toHaveBeenCalledTimes(1);
        expect(bridge.switchSession).toHaveBeenCalledWith("main:1", first.path);
        answer({ cancelled: false });
        restore();
    });

    it("keeps the transcript of the session a cancelled switch leaves alone", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        bridge.listSessions.mockResolvedValue([sessionSummary({ name: "The other one" })]);
        // An extension of pi refused the switch, so the session is what it was.
        bridge.switchSession.mockResolvedValue({ cancelled: true });

        renderScreen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        // The narrow window shows the list again as a sheet; the column is still
        // mounted behind it, so the row is searched inside the sheet.
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the row arrives with that read.
        fireEvent.click(await within(sheet).findByText("The other one"));

        await waitFor(() => expect(bridge.switchSession).toHaveBeenCalledTimes(1));
        expect(bridge.getEntries).toHaveBeenCalledTimes(1);
        expect(screen.getByText("first words")).toBeInTheDocument();
        restore();
    });

    it("announces a switch that failed, and keeps the session that runs", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        bridge.listSessions.mockResolvedValue([sessionSummary({ name: "The other one" })]);
        bridge.switchSession.mockRejectedValue({
            type: "rpc",
            message: "raw",
            error: { kind: "rpc" },
        });

        renderScreen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        // The narrow window shows the list again as a sheet; the column is still
        // mounted behind it, so the row is searched inside the sheet.
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the row arrives with that read.
        fireEvent.click(await within(sheet).findByText("The other one"));

        expect(await screen.findByText("pi refused the command.")).toBeInTheDocument();
        expect(screen.getByText("first words")).toBeInTheDocument();
        restore();
    });
});

/** The snapshot shape of a read, from a chain of entries. */
function storeOfEntries(entries: ReturnType<typeof chain> = []) {
    const store = storeOf(entries);
    return { entries, leafId: store.order.length > 0 ? store.order[store.order.length - 1] : null };
}
