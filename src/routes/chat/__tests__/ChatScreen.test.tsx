import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { queryDefaults } from "@/lib/query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui";
import type * as Bridge from "@/lib/bridge";
import type { SessionLifecycle } from "@/lib/bridge";
import type { Event } from "@/lib/rpc-protocol";
import { useSessionSync } from "@/hooks";
import { forgetSession, phases } from "@/lib/session";
import { ChatScreen } from "@/routes/chat/ChatScreen";
import { sessionOf } from "@/lib/session";
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

type Call = (...args: never[]) => Promise<unknown>;
type ListenEvent = (session: string, handler: (payload: Event) => void) => Promise<() => void>;
type ListenState = (session: string, handler: (payload: SessionLifecycle) => void) => Promise<() => void>;
type ListenExtension = (session: string, handler: (payload: Bridge.ExtensionEvent) => void) => Promise<() => void>;

const bridge = vi.hoisted(() => ({
    getConnection: vi.fn<Call>(),
    attachSession: vi.fn<Call>(),
    startSession: vi.fn<Call>(),
    detachSession: vi.fn<Call>(),
    listDirs: vi.fn<Call>(),
    getState: vi.fn<Call>(),
    getEntries: vi.fn<Call>(),
    getSessionStats: vi.fn<Call>(),
    listSessions: vi.fn<Call>(),
    clearQueue: vi.fn<Call>(),
    onSessionEvent: vi.fn<ListenEvent>(),
    onSessionState: vi.fn<ListenState>(),
    getExtensionState: vi.fn<Call>(),
    onExtensionEvent: vi.fn<ListenExtension>(),
    answerExtension: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/** Which machine pie is on: the frame reads it, and a test can change it. */
const platform = vi.hoisted(() => ({ mobile: false }));

vi.mock("@/hooks/usePlatform", () => ({
    useIsMobile: () => platform.mobile,
}));

/**
 * The list draws by measurement, and this environment lays nothing out: every
 * ancestor reports a height of 0, whatever its style says, so the real list draws
 * no rows at all and a test that went through it would hold nothing of what a
 * reader sees. The rows are drawn here instead, and the list's own behaviour -
 * following the end, the jump pill - is out of scope of this file.
 */
// The list virtualizes the transcript; here it draws every row it is given, so a
// test can read them. The element that scrolls is the scroll area's viewport, and
// the list reaches it through `scrollRef`.
vi.mock("virtua", () => ({
    Virtualizer: ({ data, children }: { data: unknown[]; children: (row: unknown) => ReactNode }) => (
        <div>{data.map(children)}</div>
    ),
}));

const CONNECTED = {
    id: "main",
    endpoint: { kind: "local" },
    sessions: [{ id: "main:1", cwd: "/home/kui04/work" }],
};

/**
 * The sessions the connection holds, as the mocks below keep them in step with Rust: an attach
 * adds one, a detach takes it away. The workspace reads this list, and the charts of the
 * sessions follow it (`useSessionSync.ts`), so a test that attaches must see the list grow.
 */
let held: { id: string; cwd: string | null }[] = [];

/** The connection the workspace reads, with the sessions it holds now. */
function connected() {
    return { id: "main", endpoint: { kind: "local" as const }, sessions: [...held] };
}

/** A window that has just connected: the machine is there and no pi runs on it. */
function noSessionYet(): void {
    held = [];
}

/**
 * A window of a stated width, and the way back to the real one.
 *
 * The workspace reads the layout width itself (the list is a panel of its own
 * from `lg`): without this, a test of either shape would be a test of whichever
 * width the environment happens to report.
 */
function windowOf(width: "narrow" | "wide"): () => void {
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
        value: width === "wide" ? 1280 : 800,
        configurable: true,
    });
    window.dispatchEvent(new Event("resize"));
    return () => {
        Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
        window.dispatchEvent(new Event("resize"));
    };
}

/**
 * The rows of the transcript are drawn by a list that measures itself, and this
 * environment does not lay anything out: the height has to be in a style, where
 * the list can read it, or it draws nothing.
 *
 * The screen reads its connection through TanStack Query and its landing links
 * to the gate, so it needs a client above it and a router around it - the same
 * two things the app's own mounting gives it. The gate itself stands at `/`, so a
 * test can see the window leave for it.
 */
/**
 * The bar's key to the list, by its own id.
 *
 * A sheet that was just closed leaves the page out of the accessible tree in this
 * environment - jsdom runs no exit animation, so the drawer never unmounts - and a query by
 * role would not find a key that is there.
 */
function sessionsKey(): HTMLElement {
    const key = document.querySelector<HTMLElement>("#sidebar_toggle");
    if (key === null) throw new Error("the bar's key to the list is not there");
    return key;
}

function renderScreen(client = new QueryClient(queryDefaults)) {
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={["/chat"]}>
                {/* The toast stack belongs to the app; the workspace announces
                    what a switch could not do. */}
                <Toaster position="top-center" />
                {/* The app's root holds the charts of the sessions, not the screen: without
                    it here, nothing would open a session the workspace is about to show. */}
                <SessionSync />
                <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
                    <Routes>
                        <Route path="/chat" element={<ChatScreen />} />
                        <Route path="/" element={<p>the gate stands here</p>} />
                    </Routes>
                </div>
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

/** The one line the app's shell adds above the routes (`App.tsx`). */
function SessionSync() {
    useSessionSync();
    return null;
}

beforeEach(() => {
    platform.mobile = false;
    vi.clearAllMocks();
    held = [...CONNECTED.sessions];
    bridge.onSessionEvent.mockResolvedValue(() => undefined);
    bridge.onSessionState.mockResolvedValue(() => undefined);
    bridge.onExtensionEvent.mockResolvedValue(() => undefined);
    bridge.getExtensionState.mockResolvedValue({
        requests: [],
        statuses: [],

        title: null,
        editorText: null,
    });
    bridge.getState.mockResolvedValue(sessionState());
    bridge.getConnection.mockImplementation(async () => connected());
    bridge.attachSession.mockImplementation(async () => {
        const id = `main:${held.length + 1}`;
        held.push({ id, cwd: "/home/kui04/work" });
        return { id, cwd: "/home/kui04/work" };
    });
    bridge.startSession.mockImplementation(async (cwd: string | undefined) => {
        const id = `main:${held.length + 1}`;
        held.push({ id, cwd: cwd ?? null });
        return { id, cwd: cwd ?? null };
    });
    bridge.listDirs.mockResolvedValue({
        directory: "/home/kui",
        entries: [{ name: "Projects", path: "/home/kui/Projects", isDir: true }],
    });
    bridge.detachSession.mockImplementation(async (session: string) => {
        held = held.filter((running) => running.id !== session);
    });
    bridge.getSessionStats.mockResolvedValue(sessionStats());
    bridge.getEntries.mockResolvedValue({ entries: [], leafId: null });
    bridge.listSessions.mockResolvedValue([]);
    bridge.clearQueue.mockResolvedValue({ steering: [], followUp: [] });
});

afterEach(() => {
    // A test is a window of its own: the charts of its connection go with it, as the app's go
    // with the connection (`lib/session/registry.ts`).
    for (const session of [...phases().keys()]) forgetSession(session);
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
    if (window.innerWidth < 1024) {
        fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    }
    // The name of a row carries its mark as well (`Fix the parser attached`), so the lookup
    // matches the title instead of equalling it.
    fireEvent.click(await screen.findByRole("button", { name: (name) => name.includes(rows[0].name ?? "") }));
    return view;
}

describe("ChatScreen", () => {
    // A window with no connection at all is the boundary's business and not this screen's: the
    // three tests of that decision live in `hooks/__tests__/useConnectionWatch.test.tsx`.

    it("draws no page of the chat while it has no connection to speak through", () => {
        // The read that will answer is still on its way: the window is its frame
        // alone, not a landing whose note the return to the gate would take away
        // again a frame later.
        bridge.getConnection.mockReturnValue(new Promise(() => undefined));
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["connection"], null);

        const { container } = renderScreen(client);

        expect(container.querySelector("#window")).not.toBeNull();
        expect(container.querySelector("#chat-landing")).toBeNull();
        expect(screen.queryByText("This window is not connected to a host.")).toBeNull();
    });

    it("lands on the words of pi before a conversation is chosen", async () => {
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

    it("starts a new conversation in the folder that was chosen", async () => {
        // A new conversation has no file until it is spoken in: the picker walks the
        // host's folders, and the directory it answers with is where pi starts.
        const restore = windowOf("wide");
        noSessionYet();
        bridge.listSessions.mockResolvedValue([]);

        renderScreen();

        await screen.findByText(/There are many agent harnesses/);
        // The landing's keys are labels only: the list's own key starts the flow.
        fireEvent.click(await screen.findByRole("button", { name: "New Conversation" }));

        // The home of the host, and the folder the press selects into the field.
        fireEvent.click(await screen.findByRole("option", { name: "/home/kui/Projects" }));
        const choose = await screen.findByRole("button", { name: "Open" });
        await waitFor(() => expect(choose).toBeEnabled());
        fireEvent.click(choose);

        await waitFor(() => expect(bridge.startSession).toHaveBeenCalledWith("/home/kui/Projects"));
        // The session that answered stands in view, with nothing said in it yet.
        expect(await screen.findByText("Nothing has been said yet.")).toBeInTheDocument();
        restore();
    });

    it("starts pi on the conversation that was picked when none holds it", async () => {
        // A machine that is only browsed runs no pi: the landing lists the files, and the
        // pick is what starts a pi on the file it names.
        noSessionYet();
        bridge.listSessions.mockResolvedValue([HELD]);

        renderScreen();

        expect(await screen.findByText(/There are many agent harnesses/)).toBeInTheDocument();
        expect(bridge.attachSession).not.toHaveBeenCalled();

        fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/ }));

        await waitFor(() => expect(bridge.attachSession).toHaveBeenCalledWith(HELD.path));
    });

    it("says it is opening the conversation while the attach runs", async () => {
        noSessionYet();
        bridge.listSessions.mockResolvedValue([HELD]);
        // The attach does not answer yet, so the window is on the page that says a
        // conversation is coming.
        bridge.attachSession.mockReturnValue(new Promise(() => undefined));

        renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/ }));

        expect(await screen.findByText("Opening the conversation…")).toBeInTheDocument();
    });

    it("says why pi could not be started, and starts it again on Try again", async () => {
        noSessionYet();
        bridge.listSessions.mockResolvedValue([HELD]);
        bridge.attachSession.mockRejectedValueOnce(new Error("pi is not on PATH"));
        bridge.attachSession.mockReturnValue(new Promise(() => undefined));

        renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/ }));

        // The screen shows the message Rust sent, with no table of its own.
        expect(await screen.findByText("pi is not on PATH")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("Opening the conversation…")).toBeInTheDocument();
        expect(bridge.attachSession).toHaveBeenCalledTimes(2);
    });

    it("says it is opening a conversation while it opens", async () => {
        bridge.listSessions.mockResolvedValue([HELD]);
        // The entries of the conversation do not answer yet, so the window is loading.
        bridge.getEntries.mockReturnValue(new Promise(() => undefined));

        const { container } = renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/ }));

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
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("hello")))));

        const { container } = await renderOpen();

        expect(await screen.findByText("hello")).toBeInTheDocument();
        expect(container.querySelector("#session_name")).toHaveTextContent("Fix the parser");
        // A conversation that has words keeps its composer at the foot, under them:
        // a row of the column and not a layer over the list, so the scrollbar
        // maps to the rows alone. A fade over the last rows leads into it.
        const band = container.querySelector("#composer-band");
        // The band is a row of the session body under the bar, under the words: it leaves
        // and arrives with them, and no row hides under it.
        expect(band?.parentElement?.id).toBe("session-body");
        expect(band?.parentElement?.parentElement?.id).toBe("session-page");
        expect(band?.parentElement?.parentElement?.parentElement?.id).toBe("session-column");
        expect(band?.className).toContain("shrink-0");
        expect(band?.className).not.toContain("absolute");
        expect(container.querySelector("#session-loading")).toBeNull();
    });

    it("attaches pi on the conversation that was chosen from the landing", async () => {
        // The list of the landing holds a conversation the connection does not: a session
        // is one process with one conversation, so the pick starts a pi on that file.
        const other = sessionSummary({ name: "The other one" });
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("the other conversation")))));

        await renderOpen([other]);

        expect(bridge.attachSession).toHaveBeenCalledWith(other.path);
        expect(await screen.findByText("the other conversation")).toBeInTheDocument();
    });

    it("gives the whole window to the chat when it is too narrow for a list", async () => {
        const restore = windowOf("narrow");
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = await renderOpen();
        await screen.findByText("Nothing has been said yet.");

        expect(container.querySelector("#sidebar")).toBeNull();
        expect(container.querySelectorAll("#window")).toHaveLength(1);
        expect(container.querySelector("#safe-main")).not.toBeNull();
        restore();
    });

    it("holds the list in a sheet where the window is too narrow for a column", async () => {
        const restore = windowOf("narrow");
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        renderScreen();
        // The landing carries the same key the session's own bar does.
        fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
        // The sheet carries the same list the column would.
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
        restore();
    });

    it("keeps the session sheet open while the folder picker is up", async () => {
        const restore = windowOf("narrow");
        bridge.listSessions.mockResolvedValue([]);

        renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
        const sheet = await screen.findByRole("dialog");

        fireEvent.click(within(sheet).getByRole("button", { name: "New Conversation" }));

        expect(await screen.findByText("Choose a folder")).toBeInTheDocument();
        expect(document.getElementById("session-sheet")).not.toBeNull();
        restore();
    });

    it("stands the list in a column of its own when the window holds one", async () => {
        const restore = windowOf("wide");
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
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = await renderOpen();
        await screen.findByText("Nothing has been said yet.");

        fireEvent.click(sessionsKey());
        await waitFor(() => expect(container.querySelector("#sidebar")).toBeNull());
        expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute("aria-expanded", "false");
        restore();
    });

    it("keeps the window and the list when a conversation opens", async () => {
        const restore = windowOf("wide");
        bridge.listSessions.mockResolvedValue([HELD]);
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("hello")))));

        const { container } = renderScreen();
        await screen.findByText(/There are many agent harnesses/);
        const sidebar = container.querySelector("#sidebar");
        const drawer = container.querySelector("#session-drawer");
        const bar = container.querySelector("#topbar");
        const toggles = container.querySelector("#sidebar_toggle");
        const keys = container.querySelector("#window_controllers");

        fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/ }));
        await screen.findByText("hello");

        // The window, the list and the bar belong to the workspace: opening a conversation
        // replaces the region under the bar and the session's own slots in it - its name and
        // its context - and rebuilds nothing else. The list the reader was looking at keeps
        // its search, its scroll and its rows, and the way to it and the window's own keys
        // stand where they were.
        expect(container.querySelector("#sidebar")).toBe(sidebar);
        expect(container.querySelector("#session-drawer")).toBe(drawer);
        expect(container.querySelector("#topbar")).toBe(bar);
        expect(container.querySelector("#sidebar_toggle")).toBe(toggles);
        expect(container.querySelector("#window_controllers")).toBe(keys);
        restore();
    });

    it("says a session is empty rather than showing nothing", async () => {
        bridge.getEntries.mockResolvedValue(storeOfEntries());

        const { container } = await renderOpen();

        expect(await screen.findByText("Nothing has been said yet.")).toBeInTheDocument();
        expect(container.querySelector("#transcript-list")).toBeNull();
        // A conversation with nothing in it holds its composer, and the sentence that
        // says why, at the foot of the window: there are no words to stand under.
        const band = container.querySelector("#composer-band");
        expect(band?.className).toContain("mt-auto");
        expect(band?.querySelector("p")?.textContent).toBe("Nothing has been said yet.");
    });

    it("does not open the conversation that is already open", async () => {
        // Pi reloads the file it is asked for even when it already holds it, so a press
        // on the row of the conversation on screen must not reach it: the window would
        // empty itself for a read it did not need.
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));

        await renderOpen();
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /Fix the parser/ }));

        expect(bridge.attachSession).not.toHaveBeenCalled();
        expect(screen.getByText("first words")).toBeInTheDocument();
        expect(screen.queryByText("Opening the session…")).toBeNull();
    });

    it("gives up the conversation it is leaving for the loading page", async () => {
        // A pick is the passage from the words to the page that says a conversation is
        // coming: the rows of the one being left are given up at once, and the reads of
        // the new session do not stand in for them.
        const other = sessionSummary({ name: "The other one" });
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        bridge.attachSession.mockReturnValue(new Promise(() => undefined));

        const view = await renderOpen([HELD, other]);
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /The other one/ }));

        expect(await screen.findByText("Opening the conversation…")).toBeInTheDocument();
        expect(screen.queryByText("first words")).toBeNull();
        expect(view.container.querySelector("#transcript-list")).toBeNull();
        // The page says nothing about a conversation: no words, no name in the bar, no
        // composer, and no hint that a conversation with nothing in it was the problem.
        expect(view.container.querySelector("#session_name")).toBeNull();
        expect(view.container.querySelector("#composer-band")).toBeNull();
        expect(screen.queryByText("Nothing has been said yet.")).toBeNull();
    });

    it("draws the transcript of the session of the connection", async () => {
        const entries = chain(messageEntry(user("make the parser skip empty lines")));
        bridge.getEntries.mockResolvedValue(storeOfEntries(entries));

        await renderOpen();

        // The row itself is what is asserted: a screen that wired the store to a
        // list, and lost the entries between them, would still draw the list.
        expect(await screen.findByText("make the parser skip empty lines")).toBeInTheDocument();
    });

    it("says which failure stopped the read", async () => {
        bridge.getEntries.mockRejectedValue({
            type: "session",
            message: "this connection has no session `main:1`",
            error: { kind: "unknown_session" },
        });

        await renderOpen();

        // The screen shows the message Rust sent, with no table of its own.
        await waitFor(() => expect(screen.getByText("this connection has no session `main:1`")).toBeInTheDocument());
    });

    it("shows the message Rust sent for a failure it has never seen", async () => {
        bridge.getEntries.mockRejectedValue({
            type: "rpc",
            message: "a_kind_of_a_later_pi",
            error: { kind: "a_kind_of_a_later_pi" },
        });

        await renderOpen();

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("a_kind_of_a_later_pi"));
    });

    it("blames the listeners before the reads when both failed", async () => {
        bridge.onSessionEvent.mockRejectedValue({
            type: "rpc",
            message: "the feed failed",
            error: { kind: "closed" },
        });
        bridge.getEntries.mockRejectedValue({
            type: "session",
            message: "a read failed",
            error: { kind: "unknown_session" },
        });

        await renderOpen();

        // A read that failed while the pipe is closed says nothing new: the screen
        // offers the failure that explains the other one.
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the feed failed"));
        expect(screen.getByRole("alert")).not.toHaveTextContent("a read failed");
    });

    it("opens the listeners again when the reader asks for another try", async () => {
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
        bridge.getEntries.mockResolvedValue(storeOfEntries());
        bridge.clearQueue.mockResolvedValue({ steering: ["run the tests first"], followUp: [] });

        await renderOpen();
        // Wait for the session to be open first: opening one clears the store it reads
        // through, and the queue of a session arrives after that.
        await screen.findByText("Nothing has been said yet.");
        act(() => {
            const chart = sessionOf("main:1");
            if (chart === null) throw new Error("the chart of the session is not running");
            chart.send({
                type: "RECORD",
                at: 0,
                record: { type: "queue_update", steering: ["run the tests first"], followUp: [] },
            });
        });

        // A queued prompt is a row of the thread, below what was said.
        expect(await screen.findByText("run the tests first")).toBeInTheDocument();
        expect(screen.getByText("queued · steer")).toBeInTheDocument();

        fireEvent.contextMenu(screen.getByText("run the tests first"));
        fireEvent.click(await screen.findByText("Retract queued message"));

        await waitFor(() => expect(bridge.clearQueue).toHaveBeenCalledWith("main:1"));
    });

    it("attaches another session on a pick while the feed of this one is still opening", async () => {
        // A session is one process with one conversation, and a second one is a second
        // process: the pick does not wait for the listeners of the session in view, and it
        // does not disturb it either.
        const other = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([HELD, other]);
        // The listeners of this session never open.
        bridge.onSessionEvent.mockReturnValue(new Promise(() => undefined));

        // A wide window keeps the list as a column, which is mounted from the first
        // frame: the pick is reachable while the feed is still opening.
        const restore = windowOf("wide");
        renderScreen();
        fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/ }));
        expect(await screen.findByText("Opening the session…")).toBeInTheDocument();

        const row = await screen.findByText("The other one");
        expect(row.closest("button")).not.toBeDisabled();
        fireEvent.click(row);
        await waitFor(() => expect(bridge.attachSession).toHaveBeenCalledWith(other.path));
        restore();
    });

    it("attaches a session on the conversation that was picked, and reads it", async () => {
        const restore = windowOf("narrow");
        bridge.getEntries
            .mockResolvedValueOnce(storeOfEntries(chain(messageEntry(user("first words")))))
            .mockResolvedValue(storeOfEntries(chain(messageEntry(user("the other conversation")))));
        const target = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([HELD, target]);

        await renderOpen([HELD, target]);
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(sessionsKey());
        // The narrow window shows the list again as a sheet; the column is still
        // mounted behind it, so the row is searched inside the sheet.
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the row arrives with that read.
        fireEvent.click(await within(sheet).findByText("The other one"));

        // The path of the row is the one that is handed over: pi reads the file itself.
        await waitFor(() => expect(bridge.attachSession).toHaveBeenCalledWith(target.path));
        // The session the attach answered with is the one in view. The one that was in view
        // keeps running - another session of the same connection - so the words of the
        // conversation it holds are gone from the screen and nothing is ended.
        expect(await screen.findByText("the other conversation")).toBeInTheDocument();
        expect(screen.queryByText("first words")).toBeNull();
        expect(bridge.detachSession).not.toHaveBeenCalled();
        restore();
    });

    it("keeps the words on screen while an event has the read asked again", async () => {
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
            publish({
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
        );

        await waitFor(() => expect(sessionOf("main:1")?.getSnapshot().context.live.messages).toEqual([]));
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

        act(() => publish({ type: "agent_settled", aborted: false }));

        await waitFor(() => expect(screen.queryByText("Working…")).not.toBeInTheDocument());
    });

    it("draws a call as it runs, and keeps the card when the read replaces the row", async () => {
        // Pi writes the messages of a run to the session file only at the end of it, so
        // the live rows are the only thing that shows an answer while it arrives. The
        // read that follows the run is the authority, and the row it becomes keeps the
        // name the live row had: without that, the card of a call would start over - its
        // clock, the body the reader opened - at the moment the run ends.
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
        act(() => publish({ type: "agent_settled", aborted: false }));

        // One call is not a fold: no heading stands over it, and the name of the live row is
        // the name it keeps - the row a reader was reading is still the row that settles, and
        // its body opens onto the answer the read carried.
        await waitFor(() => expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull());
        const settled = document.querySelector("#live-1-c1") as HTMLElement;
        expect(settled).not.toBeNull();
        expect(within(settled).getByText("pnpm test")).toBeInTheDocument();
        fireEvent.click(within(settled).getByRole("button", { name: /pnpm test/ }));
        expect(await within(settled).findByText("PASS 13 tests")).toBeInTheDocument();
    });

    it("follows the response that streams with the ring of the usage", async () => {
        // The usage of a response is written to the session file with its message, so the
        // reads of the usage are behind it until the response is over. The ring follows the
        // deltas meanwhile, which carry the response's own cumulative usage.
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

    it("sends one attach for two rows that are picked at the same instant", async () => {
        const restore = windowOf("narrow");
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        const first = sessionSummary({ name: "The first one" });
        const second = sessionSummary({ name: "The second one" });
        bridge.listSessions.mockResolvedValue([HELD, first, second]);
        // A host across a network answers when it answers, and until it does the reader
        // can pick another row; the chart is on its way to one session, and a second pick
        // would leave whichever process ended last on screen.
        let answer: (data: unknown) => void = () => undefined;
        bridge.attachSession.mockReturnValue(new Promise((resolve) => (answer = resolve)));

        await renderOpen([HELD, first, second]);
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(sessionsKey());
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the rows arrive with that read.
        fireEvent.click(await within(sheet).findByText("The first one"));
        fireEvent.click(within(sheet).getByText("The second one"));

        expect(bridge.attachSession).toHaveBeenCalledTimes(1);
        expect(bridge.attachSession).toHaveBeenCalledWith(first.path);
        answer({ id: "main:2", cwd: null });
        restore();
    });

    it("says a pick that could not attach, and ends no session for it", async () => {
        const restore = windowOf("narrow");
        bridge.getEntries.mockResolvedValue(storeOfEntries(chain(messageEntry(user("first words")))));
        const other = sessionSummary({ name: "The other one" });
        bridge.listSessions.mockResolvedValue([HELD, other]);
        bridge.attachSession.mockRejectedValue({
            type: "rpc",
            message: "pi refused the conversation",
            error: { kind: "command" },
        });

        await renderOpen([HELD, other]);
        expect(await screen.findByText("first words")).toBeInTheDocument();

        fireEvent.click(sessionsKey());
        // The narrow window shows the list again as a sheet; the column is still
        // mounted behind it, so the row is searched inside the sheet.
        const sheet = await screen.findByRole("dialog");
        // The sheet reads the list when it opens, so the row arrives with that read.
        fireEvent.click(await within(sheet).findByText("The other one"));

        // The page says what the attach failed on, and the session that was in view was not
        // ended: a pick that could not attach changes nothing of the processes.
        expect(await screen.findByText("pi refused the conversation")).toBeInTheDocument();
        expect(bridge.detachSession).not.toHaveBeenCalled();
        restore();
    });
});

/** The snapshot shape of a read, from a chain of entries. */
function storeOfEntries(entries: ReturnType<typeof chain> = []) {
    const store = storeOf(entries);
    return { entries, leafId: store.order.length > 0 ? store.order[store.order.length - 1] : null };
}

/**
 * The frame is the screen's own, so what the window's bar does is pinned here: it
 * is the handle of a window without decorations, the page's slots stand before the
 * window's keys, and the page itself - not the bar - is the safe area.
 */
describe("the window the chat draws", () => {
    it("carries the drag handle, the page's slots and the window's keys", async () => {
        bridge.listSessions.mockResolvedValue([HELD]);

        const { container } = renderScreen();
        await screen.findByText(/There are many agent harnesses/);

        const bar = container.querySelector("#topbar");
        // `deep`: a press anywhere on the bar drags the window, while the buttons
        // in it keep their own clicks (see tauri's `window/scripts/drag.js`).
        expect(bar?.getAttribute("data-tauri-drag-region")).toBe("deep");
        const ids = [...(bar?.children ?? [])].map((child) => child.id);
        expect(ids).toEqual(["topbar-start", "topbar-end", "topbar-fade"]);
        expect(bar?.querySelector("#topbar-start #sidebar_toggle")).not.toBeNull();
        expect(bar?.querySelector("#topbar-end #window_controllers")).not.toBeNull();
        // A row of the content column, not a fixed height: its own content decides.
        expect(bar?.className.split(" ")).toContain("min-h-11");
    });

    it("draws the bar before the page has slots to carry", () => {
        // The read of the connection has not answered: the page has no slots, and the
        // bar is the window's own keys alone.
        bridge.getConnection.mockReturnValue(new Promise(() => undefined));

        const { container } = renderScreen();

        expect(container.querySelector("#topbar")).not.toBeNull();
        expect(container.querySelector("#window_controllers")).not.toBeNull();
        expect(container.querySelector("#sidebar_toggle")).toBeNull();
    });

    it("keeps the system bars' room on the page, not on the bar", async () => {
        bridge.listSessions.mockResolvedValue([HELD]);

        const { container } = renderScreen();
        await screen.findByText(/There are many agent harnesses/);

        // The page is the safe area, so the room is taken once, by the column.
        const safe = container.querySelector<HTMLElement>("#safe-main");
        expect(safe?.style.getPropertyValue("--safe-area-top")).toBe("env(safe-area-inset-top, 0px)");
        expect(safe?.style.getPropertyValue("--safe-area-bottom")).toBe("env(safe-area-inset-bottom, 0px)");
        expect(safe?.style.getPropertyValue("--safe-area-left")).toBe("env(safe-area-inset-left, 0px)");
        expect(safe?.style.getPropertyValue("--safe-area-right")).toBe("env(safe-area-inset-right, 0px)");
        expect(container.querySelector<HTMLElement>("#topbar")?.style.paddingTop).toBe("");
    });

    it("keeps the window's keys to a desktop, and the page's slots everywhere", async () => {
        platform.mobile = true;
        bridge.listSessions.mockResolvedValue([HELD]);

        const { container } = renderScreen();
        await screen.findByText(/There are many agent harnesses/);

        expect(container.querySelector("#sidebar_toggle")).not.toBeNull();
        expect(container.querySelector("#window_controllers")).toBeNull();
    });
});
