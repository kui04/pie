import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { SessionSidebar, type SessionSidebarProps } from "@/routes/chat/sidebar/SessionSidebar";
import { sessionSummary } from "@/preview/fixtures";

type Call = () => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    listSessions: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/**
 * The sidebar reads the listing through TanStack Query, so it needs a client above
 * it - with the app's own defaults, because a warm cache is part of what a second
 * visit to this panel does.
 */
function renderSidebar(props: Partial<SessionSidebarProps> = {}) {
    const client = new QueryClient(queryDefaults);
    return render(
        <QueryClientProvider client={client}>
            <Wrapper>
                <SessionSidebar
                    id="session"
                    endpoint="local"
                    currentSessionId={null}
                    working={false}
                    busy={false}
                    onPick={() => undefined}
                    wide
                    column
                    sheet={false}
                    onOpenSheet={() => undefined}
                    {...props}
                />
            </Wrapper>
        </QueryClientProvider>,
    );
}

/** The panel does not scroll in this environment; its height comes from its box. */
function Wrapper({ children }: { children: ReactNode }) {
    return <div style={{ height: 400 }}>{children}</div>;
}

/** A window that answers one query, and can be told to change its answer. */
function windowThatMatches() {
    const listeners: Array<() => void> = [];
    let matches = false;
    const list = {
        get matches() {
            return matches;
        },
        media: "(min-width: 64rem)",
        addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: () => undefined,
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(list);
    return {
        becomeWide: () => {
            matches = true;
            for (const listener of listeners) listener();
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    bridge.listSessions.mockResolvedValue([]);
});

describe("SessionSidebar", () => {
    it("leaves the system bars' room to whatever holds it", () => {
        renderSidebar();

        // The panel is one root for both shapes - the column and the sheet - and the
        // room is the page's in the column (the column's page is a `SafeArea`) and the
        // sheet's own in the sheet: the panel itself takes no side, or a phone would
        // keep the status bar's room twice.
        const root = document.querySelector("#session-drawer");
        expect(root?.className).not.toContain("pt-safe");
        expect(root?.className).not.toContain("pb-safe");
    });

    it("groups the rows by the directory their sessions started in", async () => {
        bridge.listSessions.mockResolvedValue([
            sessionSummary({ cwd: "/work/pie", name: "Pie work" }),
            sessionSummary({ cwd: "/work/other", name: "Other work" }),
        ]);

        renderSidebar();

        expect(await screen.findByText("Pie work")).toBeInTheDocument();
        expect(screen.getByText("/work/pie")).toBeInTheDocument();
        expect(screen.getByText("/work/other")).toBeInTheDocument();
    });

    it("reads a row that pi holds nothing about as a time to choose by", async () => {
        const named = sessionSummary({ name: null, firstMessage: "  make it faster  " });
        const bare = sessionSummary({ name: null, firstMessage: null });
        bridge.listSessions.mockResolvedValue([named, bare]);
        const picked = vi.fn();

        renderSidebar({ onPick: picked });

        // The words that opened the conversation stand in for a name, in one line.
        expect(await screen.findByText("make it faster")).toBeInTheDocument();
        // A session with neither is still a conversation to continue. Its row
        // carries the time it was last written, which the clock of the run decides,
        // so the row is found by the path it carries rather than by what it says.
        const row = document.querySelector(`[data-path="${bare.path}"]`);
        expect(row).not.toBeNull();
        fireEvent.click(row!);
        expect(picked).toHaveBeenCalledWith(bare.path);
    });

    it("hands the path of the row that was chosen to the workspace", async () => {
        const picked = vi.fn();
        const session = sessionSummary({ name: "Fix the parser" });
        bridge.listSessions.mockResolvedValue([session]);

        renderSidebar({ onPick: picked });

        fireEvent.click(await screen.findByText("Fix the parser"));
        expect(picked).toHaveBeenCalledWith(session.path);
    });

    it("marks the conversation this window shows, and whether it works", async () => {
        const mine = sessionSummary({ name: "Mine" });
        const other = sessionSummary({ name: "Other" });
        bridge.listSessions.mockResolvedValue([mine, other]);

        const { rerender } = renderSidebar({ currentSessionId: mine.id, working: false });

        const selector = `[data-path="${mine.path}"]`;
        await waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
        const row = document.querySelector(selector) as HTMLElement;
        expect(within(row).getByText("attached")).toBeInTheDocument();
        // The mark stands before the time: the two right-hand facts of a row, and
        // the order the design owner asked for (2026-10-07).
        const mark = row.querySelector("span.rounded-full");
        const time = row.querySelector("span.text-label-md");
        expect(mark).not.toBeNull();
        expect(time).not.toBeNull();
        expect(mark!.compareDocumentPosition(time!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        rerender(
            <QueryClientProvider client={new QueryClient(queryDefaults)}>
                <Wrapper>
                    <SessionSidebar
                        id="session"
                        endpoint="local"
                        currentSessionId={mine.id}
                        working
                        busy
                        onPick={() => undefined}
                        wide
                        column
                        sheet={false}
                        onOpenSheet={() => undefined}
                    />
                </Wrapper>
            </QueryClientProvider>,
        );
        // Working covers attached: a run implies the process behind it.
        expect(await screen.findByText("working")).toBeInTheDocument();
        expect(screen.queryByText("attached")).toBeNull();
    });

    it("filters the rows as the search is typed", async () => {
        bridge.listSessions.mockResolvedValue([
            sessionSummary({ name: "Fix the parser" }),
            sessionSummary({ name: "Rewrite the drawer" }),
        ]);

        renderSidebar();

        const search = await screen.findByLabelText("Search sessions");
        fireEvent.change(search, { target: { value: "drawer" } });

        expect(screen.getByText("Rewrite the drawer")).toBeInTheDocument();
        expect(screen.queryByText("Fix the parser")).toBeNull();
    });

    it("folds a group away, and keeps the rows of the others", async () => {
        bridge.listSessions.mockResolvedValue([
            sessionSummary({ cwd: "/work/pie", name: "Pie work" }),
            sessionSummary({ cwd: "/work/other", name: "Other work" }),
        ]);

        renderSidebar();

        const head = await screen.findByRole("button", { name: /work\/pie/ });
        expect(head).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(head);

        expect(head).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Pie work")).toBeNull();
        expect(screen.getByText("Other work")).toBeInTheDocument();
    });

    it("has a word for an empty directory and for a search that found nothing", async () => {
        renderSidebar();
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "nothing" } });
        expect(screen.getByText("No session matches")).toBeInTheDocument();
    });

    it("says that it is looking rather than that there is nothing", async () => {
        // The host may be across a network: an empty list is not yet a fact while
        // the first read is on its way.
        let answer: (rows: unknown[]) => void = () => undefined;
        bridge.listSessions.mockReturnValue(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );

        renderSidebar();

        expect(screen.getByText("Looking for sessions…")).toBeInTheDocument();
        expect(screen.queryByText("No sessions yet")).toBeNull();

        answer([]);
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    });

    it("holds every row still while a switch or a run is in the way", async () => {
        const picked = vi.fn();
        bridge.listSessions.mockResolvedValue([sessionSummary({ name: "Fix the parser" })]);

        renderSidebar({ busy: true, onPick: picked });

        const row = await screen.findByRole("button", { name: /Fix the parser/ });
        expect(row).toBeDisabled();
        fireEvent.click(row);
        expect(picked).not.toHaveBeenCalled();
    });

    it("shows the message Rust sent when the listing failed", async () => {
        bridge.listSessions.mockRejectedValue({
            type: "session",
            message: "There is no connection.",
            error: { kind: "not_connected" },
        });

        renderSidebar();

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("There is no connection."));
    });

    it("asks the host again when the reader refreshes", async () => {
        renderSidebar();
        await screen.findByText("No sessions yet");
        expect(bridge.listSessions).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Refresh the session list" }));

        // The list is not stale on its own: a session file changes with no event to
        // say so, and this key is the only thing that asks again.
        await waitFor(() => expect(bridge.listSessions).toHaveBeenCalledTimes(2));
    });

    it("lets go of the sheet when the window reaches the width of the column", async () => {
        const window_ = windowThatMatches();
        const closed = vi.fn();

        renderSidebar({ wide: false, column: false, sheet: true, onOpenSheet: closed });
        // A sheet that is closed costs nothing: nothing is asked of the host.
        expect(closed).not.toHaveBeenCalled();

        window_.becomeWide();

        // A modal holds the page itself (the body is `pointer-events: none` while it
        // is open), so a sheet that the CSS hides would leave the workspace unable to
        // be touched. This is what closes it instead. The width is read through a
        // store, so the re-render it causes is what the wait is for.
        await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
        vi.restoreAllMocks();
    });

    it("keeps the sheet's own side of the system bars, where the page's room cannot reach", async () => {
        renderSidebar({ wide: false, column: false, sheet: true });

        // A sheet leaves the page for a portal, so the shell's safe area is not around
        // it: the panel takes the room itself, or its first and last rows would sit
        // under the system bars.
        const panel = (await screen.findByText("No sessions yet")).closest("#session-sheet-drawer") as HTMLElement;
        expect(panel).not.toBeNull();
        expect(panel.parentElement?.className.split(" ")).toEqual(expect.arrayContaining(["pt-safe", "pb-safe"]));
    });
});
