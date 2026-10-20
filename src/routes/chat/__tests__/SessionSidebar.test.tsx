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
    listDirs: vi.fn<Call>(),
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
                    attached={new Map()}
                    onPick={() => undefined}
                    onNew={() => undefined}
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

/** Make the row report a clipped label, the way a browser reports an ellipsis. */
function clip(element: HTMLElement) {
    Object.defineProperty(element, "scrollWidth", { configurable: true, value: 240 });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 100 });
    window.dispatchEvent(new Event("resize"));
}

/** The pointer a preview card listens for, without a browser's own hover. */
function hover(element: HTMLElement) {
    const trigger = element.closest<HTMLElement>(String.raw`[data-slot="hover-card-trigger"]`) ?? element;
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
}

/** The card a row opened, once the delay has passed. */
async function previewCard() {
    return waitFor(() => {
        const card = document.querySelector(String.raw`[data-slot="hover-card-content"]`);
        expect(card).not.toBeNull();
        return card as HTMLElement;
    });
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
    bridge.listDirs.mockResolvedValue({ directory: "/home/user", entries: [] });
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

    it("shows a directory's full path in a preview card", async () => {
        bridge.listDirs.mockResolvedValue({ directory: "/home/user", entries: [] });
        bridge.listSessions.mockResolvedValue([sessionSummary({ cwd: "/home/user/pie", name: "Pie work" })]);

        renderSidebar();

        const path = await screen.findByText("~/pie");
        clip(path);
        hover(path);
        const card = await previewCard();
        expect(within(card).getByText("/home/user/pie")).toBeInTheDocument();
    });

    it("keeps a session's title in the directory's text column", async () => {
        bridge.listSessions.mockResolvedValue([sessionSummary({ cwd: "/work/pie", name: "Pie work" })]);

        renderSidebar();

        const row = await waitFor(() => {
            const found = document.querySelector("[data-path]");
            expect(found).not.toBeNull();
            return found as HTMLElement;
        });
        // The directory's folder uses the 24px icon slot; the row's empty status slot
        // must use the same width, or the two titles start on different columns.
        expect(row.querySelector("button > span[aria-hidden]")?.className.split(" ")).toEqual(
            expect.arrayContaining(["size-6", "shrink-0"]),
        );
    });

    it("shows a session's full name and when it was written in a preview card", async () => {
        const modified = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
        bridge.listSessions.mockResolvedValue([sessionSummary({ name: "Fix the parser", modified })]);

        renderSidebar();

        hover(await screen.findByText("Fix the parser"));
        const card = await previewCard();
        expect(within(card).getByText("Fix the parser")).toBeInTheDocument();
        expect(within(card).getByText("4d ago")).toBeInTheDocument();
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

    it("marks active sessions with BreathLight and aligns timestamp", async () => {
        const mine = sessionSummary({ name: "Mine" });
        const other = sessionSummary({ name: "Other" });
        bridge.listSessions.mockResolvedValue([mine, other]);

        const held = new Map([[mine.path, { session: "main:1", working: false }]]);
        const { rerender } = renderSidebar({ attached: held });

        const selector = `[data-path="${mine.path}"]`;
        await waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
        const row = document.querySelector(selector) as HTMLElement;
        expect(within(row).getByText("attached")).toBeInTheDocument();
        // The BreathLight dot is rendered with size-1.5
        const mark = row.querySelector("span.rounded-full");
        expect(mark).not.toBeNull();
        expect(mark?.className).toContain("size-1.5");
        // Both active and inactive sessions render timestamp with aligned layout
        expect(row.querySelector("span.text-label-md")).not.toBeNull();

        const otherRow = document.querySelector(`[data-path="${other.path}"]`) as HTMLElement;
        expect(otherRow.querySelector("span.text-label-md")).not.toBeNull();

        rerender(
            <QueryClientProvider client={new QueryClient(queryDefaults)}>
                <Wrapper>
                    <SessionSidebar
                        id="session"
                        endpoint="local"
                        attached={new Map([[mine.path, { session: "main:1", working: true }]])}
                        onPick={() => undefined}
                        onNew={() => undefined}
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

    it("triggers onNew when the New Conversation button is pressed", async () => {
        const onNew = vi.fn();
        renderSidebar({ onNew });

        const button = await screen.findByRole("button", { name: "New Conversation" });
        fireEvent.click(button);

        expect(onNew).toHaveBeenCalledTimes(1);
    });

    it("toggles between collapsing all groups and expanding all groups", async () => {
        bridge.listSessions.mockResolvedValue([
            sessionSummary({ cwd: "/work/pie", name: "Pie work" }),
            sessionSummary({ cwd: "/work/other", name: "Other work" }),
        ]);

        renderSidebar();

        expect(await screen.findByText("Pie work")).toBeInTheDocument();
        expect(screen.getByText("Other work")).toBeInTheDocument();

        const foldToggle = screen.getByRole("button", { name: "Collapse all groups" });
        fireEvent.click(foldToggle);

        expect(screen.queryByText("Pie work")).toBeNull();
        expect(screen.queryByText("Other work")).toBeNull();

        const expandToggle = screen.getByRole("button", { name: "Expand all groups" });
        fireEvent.click(expandToggle);

        expect(screen.getByText("Pie work")).toBeInTheDocument();
        expect(screen.getByText("Other work")).toBeInTheDocument();
    });

    it("simplifies the home directory with ~ using pathe", async () => {
        bridge.listDirs.mockResolvedValue({ directory: "/home/user", entries: [] });
        bridge.listSessions.mockResolvedValue([sessionSummary({ cwd: "/home/user/pie", name: "Pie work" })]);

        renderSidebar();

        expect(await screen.findByText("~/pie")).toBeInTheDocument();
    });

    it("provides session actions menu on session row", async () => {
        const session = sessionSummary({ name: "Pie work" });
        bridge.listSessions.mockResolvedValue([session]);
        const held = new Map([[session.path, { session: "main:1", working: false }]]);

        renderSidebar({ attached: held });

        expect(await screen.findByText("Pie work")).toBeInTheDocument();
        const actionButton = screen.getByRole("button", { name: "Session actions" });
        expect(actionButton).toBeInTheDocument();
        expect(
            actionButton.parentElement?.parentElement?.firstElementChild?.classList.contains(
                "group-has-focus-visible/slot:opacity-0",
            ),
        ).toBe(true);

        fireEvent.click(actionButton);
        expect(await screen.findByText("Rename")).toBeInTheDocument();
        expect(screen.getByText("Fork")).toBeInTheDocument();
        expect(screen.getByText("Clone")).toBeInTheDocument();
        expect(screen.getByText("Detach")).toBeInTheDocument();
        expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("opens the actions menu on a long touch", async () => {
        const session = sessionSummary({ name: "Pie work" });
        bridge.listSessions.mockResolvedValue([session]);

        renderSidebar();

        const title = await screen.findByText("Pie work");
        const row = title.closest("[data-path]");
        expect(row).not.toBeNull();

        fireEvent.pointerDown(row as HTMLElement, { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        fireEvent.pointerUp(row as HTMLElement, { pointerType: "touch", pointerId: 1 });
        fireEvent.click(row as HTMLElement);

        expect(await screen.findByText("Rename", {}, { timeout: 1500 })).toBeInTheDocument();
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

    it("has a word for an empty directory", async () => {
        renderSidebar();
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
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

        // The rows are held as bars while the read is on its way: the list says what it is
        // waiting for without saying words, and a blank pane is not one of the answers.
        expect(screen.getByRole("status", { name: "Loading the sessions" })).toBeInTheDocument();
        expect(screen.queryByText("No sessions yet")).toBeNull();

        answer([]);
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    });

    it("leaves the list standing while it reads the host again", async () => {
        // The press is a read of a list the reader already has: the rows stay where they are,
        // at the position they were read to, and the key that asked is the whole of the
        // progress. Bars are for a list that has nothing yet.
        const before = [sessionSummary({ name: "Fix the parser" })];
        const after = [sessionSummary({ name: "Rewrite the drawer" })];
        let answer: (rows: unknown[]) => void = () => undefined;
        bridge.listSessions.mockResolvedValueOnce(before);
        bridge.listSessions.mockReturnValueOnce(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );

        renderSidebar();
        await screen.findByText("Fix the parser");

        const key = screen.getByRole("button", { name: "Refresh the session list" });
        fireEvent.click(key);
        await waitFor(() => expect(key).toBeDisabled());

        expect(screen.getByText("Fix the parser")).toBeInTheDocument();
        expect(screen.queryByRole("status", { name: "Loading the sessions" })).toBeNull();

        // What arrives replaces what is there, in place: no bars, and nothing to wait on
        // after the words are in.
        answer(after);
        expect(await screen.findByText("Rewrite the drawer")).toBeInTheDocument();
        expect(screen.queryByText("Fix the parser")).toBeNull();
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

    it("asks the host again when the reader refreshes, and only once", async () => {
        renderSidebar();
        await screen.findByText("No sessions yet");
        expect(bridge.listSessions).toHaveBeenCalledTimes(1);

        // The second press lands before the first read has started, which is the gap the
        // key's own guard closes: two presses of one key are one read.
        const again = screen.getByRole("button", { name: "Refresh the session list" });
        fireEvent.click(again);
        fireEvent.click(again);

        // The list is not stale on its own: a session file changes with no event to
        // say so, and this key is the only thing that asks again.
        await waitFor(() => expect(bridge.listSessions).toHaveBeenCalledTimes(2));
    });

    it("stands its key out of reach while a read is in flight", () => {
        renderSidebar();

        // A key of the window's own kind (the three at the end of the bar): the same 24px
        // box, corner, padding and centred glyph, and the same hover. A key that a second press
        // reached while the first was still reading would ask the host twice.
        const key = screen.getByRole("button", { name: "Refresh the session list" });
        expect(key).toBeDisabled();
        for (const each of [
            "size-6",
            "rounded-sm",
            "p-1",
            "hover:bg-accent/50",
            "bg-transparent",
            "inline-flex",
            "items-center",
            "justify-center",
        ]) {
            expect(key.classList.contains(each)).toBe(true);
        }
        // The row the key and the heading share parts the pane's own air, so the key ends
        // where the field and the rows end.
        expect(document.getElementById("session-drawer-head")?.className.split(" ")).toContain("px-2");
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
