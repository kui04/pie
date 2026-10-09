import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { queryDefaults } from "@/lib/query";
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
import {
    assistant,
    chain,
    messageEntry,
    sessionStats,
    sessionSummary,
    sessionState,
    storeOf,
    toolCall,
    toolResult,
    usage,
    user,
} from "@/preview/fixtures";

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
    // The client of the app, not a fresh one: a warm cache is what a second visit
    // to a read depends on (`queryDefaults`).
    const client = new QueryClient(queryDefaults);
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
    bridge.getState.mockResolvedValue(sessionState());
    bridge.switchSession.mockResolvedValue({ cancelled: false });
    bridge.getSessionStats.mockResolvedValue(sessionStats());
    bridge.getEntries.mockResolvedValue({ entries: [], leafId: null });
    bridge.listSessions.mockResolvedValue([]);
    bridge.clearQueue.mockResolvedValue({ steering: [], followUp: [] });
});

/** The session the connection holds, as the list draws it. */
const HELD = sessionSummary({ name: "Fix the parser", path: sessionState().sessionFile ?? "" });

/**
 * The window with a conversation open.
 *
 * A window starts on the landing, and the list is the way out of it: this helper
 * renders the screen with the rows it is given and opens the first of them, so a
 * test about the transcript says nothing about the landing. The tests of the
 * landing itself render the screen without it.
 */
async function renderOpen(rows: Bridge.SessionSummary[] = [HELD]) {
    bridge.listSessions.mockResolvedValue(rows);
    const view = renderScreen();
    // A narrow window keeps the list in a sheet, and the bar's key opens it; a wide
    // one shows the list in a column of its own, where the row is already drawn.
    if (!window.matchMedia("(min-width: 64rem)").matches) {
        fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: rows[0].name ?? "" }));
    return view;
}

describe("ChatScreen", () => {
    it("offers the way back to the gate when no connection is held", async () => {
        bridge.getConnection.mockResolvedValue(null);

        renderScreen();

        expect(await screen.findByText(/There are many agent harnesses/)).toBeInTheDocument();
        expect(await screen.findByText("This window is not connected to a host.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/");
    });

    it("lands on the words of pi before a conversation is chosen", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.listSessions.mockResolvedValue([HELD]);

        const { container } = renderScreen();

        // The window has no conversation, so it has no bar of one: the way to the
        // list, the window's own keys, and the words of pi with the keys to come.
        expect(await screen.findByText(/There are many agent harnesses/)).toBeInTheDocument();
        expect(screen.getAllByText("Ctrl")).toHaveLength(2);
        expect(container.querySelector("#session_name")).toBeNull();
        expect(container.querySelector("#composer-band")).toBeNull();
        expect(container.querySelector("#transcript-list")).toBeNull();
    });

    it("says it is opening a conversation while it opens", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.listSessions.mockResolvedValue([HELD]);
        // The entries of the conversation do not answer yet, so the window is loading.
        bridge.getEntries.mockReturnValue(new Promise(() => undefined));

        const { container } = renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: "Fix the parser" }));

        expect(await screen.findByText("Opening the session…")).toBeInTheDocument();
        expect(container.querySelector("#session-loading")).not.toBeNull();
        // The ring says the wait is work, and it names itself to a reader that
        // cannot see it.
        expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
        // Nothing of the conversation is known yet: the bar is the landing's, and the
        // composer waits for the words it would write into.
        expect(container.querySelector("#session_name")).toBeNull();
        expect(container.querySelector("#composer-band")).toBeNull();
    });

    it("puts the conversation in the bar, and the composer under it, once it arrives", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("hello")))));

        const { container } = await renderOpen();

        expect(await screen.findByText("hello")).toBeInTheDocument();
        expect(container.querySelector("#session_name")).toHaveTextContent("Fix the parser");
        // A conversation that has words keeps its composer at the foot, under them.
        // It gives up the pill scrollbar's width there: the scroller is that much
        // narrower than the region, so a band across the whole region would put the
        // two centred columns 4px apart.
        expect(container.querySelector("#composer-band")?.className).toContain("absolute");
        expect(container.querySelector("#composer-band")?.className).toContain("sb-inset");
        // The band's own gap is above and below; the navigation bar is room the
        // content adds, so the keys never sit under the bar.
        expect(container.querySelector("#composer-band > div")?.className).toContain("pb-safe");
        expect(container.querySelector("#session-loading")).toBeNull();
    });

    it("switches pi to the conversation that was chosen from the landing", async () => {
        // The list of the landing holds a session pi does not hold: the file of the
        // row is handed over before the window opens it.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        const other = sessionSummary({ name: "The other one" });
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("the other conversation")))));

        await renderOpen([other]);

        expect(bridge.switchSession).toHaveBeenCalledWith("main:1", other.path);
        expect(await screen.findByText("the other conversation")).toBeInTheDocument();
    });

    it("gives the whole window to the chat when it is too narrow for a list", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = await renderOpen();
        await screen.findByText("Nothing has been said yet.");

        expect(container.querySelector("#sidebar")).toBeNull();
        expect(container.querySelectorAll("#window")).toHaveLength(1);
        expect(container.querySelector("#main-content")).not.toBeNull();
        restore();
    });

    it("holds the list in a sheet where the window is too narrow for a column", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        renderScreen();
        // The landing carries the same key the session's own bar does.
        fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
        // The sheet carries the same list the column would.
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
        restore();
    });

    it("stands the list in a column of its own when the window holds one", async () => {
        const restore = windowOf("wide");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = await renderOpen();
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

        const { container } = await renderOpen();
        await screen.findByText("Nothing has been said yet.");

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        await waitFor(() => expect(container.querySelector("#sidebar")).toBeNull());
        expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute("aria-expanded", "false");
        restore();
    });

    it("says a session is empty rather than showing nothing", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = await renderOpen();

        expect(await screen.findByText("Nothing has been said yet.")).toBeInTheDocument();
        expect(container.querySelector("#transcript-list")).toBeNull();
        // A conversation with nothing in it holds its composer, and the sentence that
        // says why, in the middle of the window: there are no words to stand under.
        const band = container.querySelector("#composer-band");
        expect(band?.className).toContain("m-auto");
        expect(band?.className).not.toContain("sb-inset");
        expect(band?.querySelector("p")?.textContent).toBe("Nothing has been said yet.");
    });

    it("does not open the conversation that is already open", async () => {
        // Pi reloads the file it is asked for even when it already holds it, so a press
        // on the row of the conversation on screen must not reach it: the window would
        // empty itself for a read it did not need.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));

        await renderOpen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Fix the parser" }));

        expect(bridge.switchSession).not.toHaveBeenCalled();
        expect(screen.getByText("first words")).toBeInTheDocument();
        expect(screen.queryByText("Opening the session…")).toBeNull();
    });

    it("gives up the conversation it is leaving for the loading page", async () => {
        // A switch is the passage from the loaded page to the loading page and back, so
        // the page of the conversation that is leaving is given up at once: its words do
        // not stand under the ring, and nothing of them comes back to go again. The page
        // that is left is why the reads are keyed so carefully - the answer of the
        // conversation that was left must not stand in for the one that is coming.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        const other = sessionSummary({ name: "The other one" });
        bridge.getEntries
            .mockResolvedValueOnce(storeOfEntries(chain(messageEntry(user("first words")))))
            .mockReturnValue(new Promise(() => undefined));
        bridge.switchSession.mockResolvedValue({ cancelled: false });

        const view = await renderOpen([HELD, other]);
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "The other one" }));

        await waitFor(() => expect(bridge.switchSession).toHaveBeenCalledWith("main:1", other.path));
        expect(await screen.findByText("Opening the session…")).toBeInTheDocument();
        expect(screen.queryByText("first words")).toBeNull();
        expect(view.container.querySelector("#transcript-list")).toBeNull();
        // The page says nothing about a conversation: no words, no name in the bar, no
        // composer, and no hint that a conversation with nothing in it was the problem.
        expect(view.container.querySelector("#session_name")).toBeNull();
        expect(view.container.querySelector("#composer-band")).toBeNull();
        expect(screen.queryByText("Nothing has been said yet.")).toBeNull();
    });

    it("draws the transcript of the session of the connection", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        const entries = chain(messageEntry(user("make the parser skip empty lines")));
        bridge.getEntries.mockResolvedValue(storeOfEntries(entries));

        await renderOpen();

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

        await renderOpen();

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

        await renderOpen();

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

        await renderOpen();

        // A read that failed while the pipe is closed says nothing new: the screen
        // offers the failure that explains the other one.
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The connection to pi ended."));
    });

    it("opens the listeners again when the reader asks for another try", async () => {
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.onSessionEvent.mockRejectedValueOnce({ type: "rpc", message: "raw", error: { kind: "closed" } });
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("hello again")))));

        await renderOpen();

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

        await renderOpen();
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

    it("refuses a pick while the feed of the session is not open", async () => {
        // A switch is not something a screen that never attached can ask for: the chart
        // would drop the events of it while Rust made the switch, and the screen would
        // keep the old conversation. The rows say so, and the pick does not reach Rust.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.listSessions.mockResolvedValue([HELD, sessionSummary({ name: "The other one" })]);
        bridge.switchSession.mockClear();
        // The listeners of this session never open.
        bridge.onSessionEvent.mockReturnValue(new Promise(() => undefined));

        // A wide window keeps the list as a column, which is mounted from the first
        // frame: the pick is reachable while the feed is still opening.
        const restore = windowOf("wide");
        renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: "Fix the parser" }));
        expect(await screen.findByText("Opening the session…")).toBeInTheDocument();

        const row = await screen.findByText("The other one");
        expect(row.closest("button")).toBeDisabled();
        fireEvent.click(row);
        expect(bridge.switchSession).not.toHaveBeenCalled();
        restore();
    });

    it("moves the session to the conversation that was picked, and reads it again", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries
            .mockResolvedValueOnce(storeOfEntries(chain(messageEntry(user("first words")))))
            .mockResolvedValue(storeOfEntries(chain(messageEntry(user("the other conversation")))));
        const target = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([HELD, target]);
        bridge.switchSession.mockResolvedValue({ cancelled: false });

        await renderOpen([HELD, target]);
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

        await renderOpen();
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

    it("stays at work when a read carries the message the run already wrote", async () => {
        // The messages of a run are written to the session file as they finish, so a read
        // that lands while the run goes on takes the row the run drew over with the entry of
        // that message (a compaction or a command of the reader asks for one). The line under
        // the transcript belongs to the run, not to the row: it is at work until the run is
        // over, and it does not go back to waiting for a first output.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries([]));
        let publish: (event: Event) => void = () => undefined;
        bridge.onSessionEvent.mockImplementation(async (_session, onEvent) => {
            publish = onEvent;
            return () => undefined;
        });
        const called = assistant([toolCall("c1", "bash", { command: "pnpm test" })], { stopReason: "toolUse" });

        await renderOpen();
        await waitFor(() => expect(bridge.onSessionEvent).toHaveBeenCalled());

        act(() => {
            publish({ type: "agent_start" });
            publish({ type: "message_start", message: assistant([], { stopReason: "pending" as const }) });
        });
        await waitFor(() => expect(screen.getByText("Working…")).toBeInTheDocument());

        act(() => {
            publish({ type: "message_end", message: called });
            publish({
                type: "tool_execution_start",
                toolCallId: "c1",
                toolName: "bash",
                args: { command: "pnpm test" },
            });
        });

        // The compaction that just ended asks for a read of the entries, which answers with
        // the entry of the message the run already wrote.
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(called))));
        act(() =>
            publish({ type: "compaction_end", reason: "threshold", result: null, aborted: false, willRetry: false }),
        );

        await waitFor(() => expect(useTranscriptStore.getState().live.messages).toEqual([]));
        expect(screen.getByText("Working…")).toBeInTheDocument();
        expect(screen.queryByText("Waiting…")).not.toBeInTheDocument();
        // The row stands: the read replaced it with the entry of the same message.
        expect(screen.getByText("pnpm test")).toBeInTheDocument();
    });

    it("says what the run waits on, from the send to the model's first output", async () => {
        // A connection to a machine that may be far away: between what the reader sent and
        // the model's first output there is a stretch of time with nothing on screen, and it
        // has a name. Once the model writes, the run is at work - and it stays at work while
        // it runs what the model called.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries([]));
        let publish: (event: Event) => void = () => undefined;
        bridge.onSessionEvent.mockImplementation(async (_session, onEvent) => {
            publish = onEvent;
            return () => undefined;
        });

        await renderOpen();
        await waitFor(() => expect(bridge.onSessionEvent).toHaveBeenCalled());

        act(() => {
            publish({ type: "agent_start" });
            publish({ type: "message_start", message: user("what does the parser do?") });
        });

        expect(await screen.findByText("Waiting…")).toBeInTheDocument();

        act(() => publish({ type: "message_start", message: assistant([], { stopReason: "pending" as const }) }));

        await waitFor(() => expect(screen.getByText("Working…")).toBeInTheDocument());
        expect(screen.queryByText("Waiting…")).not.toBeInTheDocument();

        act(() => {
            publish({
                type: "message_end",
                message: assistant([toolCall("c1", "bash", { command: "pnpm test" })], { stopReason: "toolUse" }),
            });
            publish({
                type: "tool_execution_start",
                toolCallId: "c1",
                toolName: "bash",
                args: { command: "pnpm test" },
            });
        });

        await waitFor(() => expect(screen.getByLabelText("Running")).toBeInTheDocument());
        expect(screen.getByText("Working…")).toBeInTheDocument();

        act(() => publish({ type: "agent_settled" }));

        await waitFor(() => expect(screen.queryByText("Working…")).not.toBeInTheDocument());
    });

    it("draws a call as it runs, and keeps the card when the read replaces the row", async () => {
        // Pi writes the messages of a run to the session file only at the end of it, so
        // the live rows are the only thing that shows an answer while it arrives. The
        // read that follows the run is the authority, and the row it becomes keeps the
        // name the live row had: without that, the card of a call would start over - its
        // clock, the body the reader opened - at the moment the run ends.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries([]));
        let publish: (event: Event) => void = () => undefined;
        bridge.onSessionEvent.mockImplementation(async (_session, onEvent) => {
            publish = onEvent;
            return () => undefined;
        });
        const command = toolCall("c1", "bash", { command: "pnpm test" });
        const streamed = { ...assistant([command], { stopReason: "pending" as const }), timestamp: 4242 };

        await renderOpen();
        await waitFor(() => expect(bridge.onSessionEvent).toHaveBeenCalled());

        act(() => {
            publish({ type: "message_start", message: streamed });
            publish({
                type: "tool_execution_start",
                toolCallId: "c1",
                toolName: "bash",
                args: { command: "pnpm test" },
            });
            publish({
                type: "tool_execution_update",
                toolCallId: "c1",
                toolName: "bash",
                args: { command: "pnpm test" },
                partialResult: { content: [{ type: "text", text: "PASS so far" }] },
            });
        });

        const card = await waitFor(() => {
            const found = document.querySelector("#live-1-c1");
            expect(found).not.toBeNull();
            return found as HTMLElement;
        });
        expect(within(card).getByText("PASS so far")).toBeInTheDocument();
        expect(within(card).getByLabelText("Running")).toBeInTheDocument();

        // The read that the end of the run asks for answers with the entries.
        bridge.getEntries.mockResolvedValue(
            storeOfEntries(
                chain(
                    messageEntry({ ...assistant([command], { stopReason: "toolUse" }), timestamp: 4242 }),
                    messageEntry(toolResult("c1", "bash", "PASS 13 tests")),
                ),
            ),
        );
        act(() => publish({ type: "agent_settled" }));

        await waitFor(() => expect(screen.getByLabelText("Succeeded")).toBeInTheDocument());
        // The same element: the row kept its name, so the card kept its state.
        expect(document.querySelector("#live-1-c1")).toBe(card);
    });

    it("follows the response that streams with the ring of the usage", async () => {
        // The usage of a response is written to the session file with its message, so the
        // reads of the usage are behind it until the response is over. The ring follows the
        // deltas meanwhile, which carry the response's own cumulative usage.
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries([]));
        bridge.getState.mockResolvedValue(sessionState({ isStreaming: true }));
        bridge.getSessionStats.mockResolvedValue(
            sessionStats({ contextUsage: { tokens: 1000, contextWindow: 100000, percent: 1 } }),
        );
        let publish: (event: Event) => void = () => undefined;
        bridge.onSessionEvent.mockImplementation(async (_session, onEvent) => {
            publish = onEvent;
            return () => undefined;
        });

        await renderOpen();
        await waitFor(() => expect(screen.getByLabelText("Context usage 1.0%")).toBeInTheDocument());

        act(() => {
            publish({ type: "message_start", message: assistant([], { stopReason: "pending" as const }) });
            publish({
                type: "message_update",
                usage: usage({ input: 49000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 50000 }),
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "an answer" },
            });
        });

        await waitFor(() => expect(screen.getByLabelText("Context usage 50.0%")).toBeInTheDocument());
    });

    it("sends one switch for two rows that are picked at the same instant", async () => {
        const restore = windowOf("narrow");
        bridge.getConnection.mockResolvedValue(CONNECTED);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        const first = sessionSummary({ name: "The first one" });
        const second = sessionSummary({ name: "The second one" });
        bridge.listSessions.mockResolvedValue([HELD, first, second]);
        // A host across a network answers when it answers, and until it does the
        // reader can pick another row; pi runs the commands of one session one after
        // another, so two switches would leave the conversation of whichever ends
        // last on screen.
        let answer: (data: unknown) => void = () => undefined;
        bridge.switchSession.mockReturnValue(new Promise((resolve) => (answer = resolve)));

        await renderOpen([HELD, first, second]);
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
        const other = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([HELD, other]);
        // An extension of pi refused the switch, so the session is what it was.
        bridge.switchSession.mockResolvedValue({ cancelled: true });

        await renderOpen([HELD, other]);
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
        const other = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([HELD, other]);
        bridge.switchSession.mockRejectedValue({
            type: "rpc",
            message: "raw",
            error: { kind: "rpc" },
        });

        await renderOpen([HELD, other]);
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
