import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { SessionDrawer } from "@/routes/chat/components/session/SessionDrawer";
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
 * The drawer reads the listing through TanStack Query, so it needs a client above
 * it - with the app's own defaults, because a warm cache is part of what a second
 * visit to this panel does.
 */
function renderDrawer(props: Partial<Parameters<typeof SessionDrawer>[0]> = {}) {
    const client = new QueryClient(queryDefaults);
    const view = render(
        <QueryClientProvider client={client}>
            <Wrapper>
                <SessionDrawer
                    id="session-drawer"
                    endpoint="local"
                    currentSessionId={null}
                    working={false}
                    busy={false}
                    onPick={() => undefined}
                    {...props}
                />
            </Wrapper>
        </QueryClientProvider>,
    );
    return { ...view, client };
}

/** The panel does not scroll in this environment; its height comes from its box. */
function Wrapper({ children }: { children: ReactNode }) {
    return <div style={{ height: 400 }}>{children}</div>;
}

beforeEach(() => {
    vi.clearAllMocks();
    bridge.listSessions.mockResolvedValue([]);
});

describe("SessionDrawer", () => {
    it("groups the rows by the directory their sessions started in", async () => {
        bridge.listSessions.mockResolvedValue([
            sessionSummary({ cwd: "/work/pie", name: "Pie work" }),
            sessionSummary({ cwd: "/work/other", name: "Other work" }),
        ]);

        renderDrawer();

        expect(await screen.findByText("Pie work")).toBeInTheDocument();
        expect(screen.getByText("/work/pie")).toBeInTheDocument();
        expect(screen.getByText("/work/other")).toBeInTheDocument();
    });

    it("reads a row that pi holds nothing about as a time to choose by", async () => {
        const named = sessionSummary({ name: null, firstMessage: "  make it faster  " });
        const bare = sessionSummary({ name: null, firstMessage: null });
        bridge.listSessions.mockResolvedValue([named, bare]);
        const picked = vi.fn();

        renderDrawer({ onPick: picked });

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

        renderDrawer({ onPick: picked });

        fireEvent.click(await screen.findByText("Fix the parser"));
        expect(picked).toHaveBeenCalledWith(session.path);
    });

    it("marks the conversation this window shows, and whether it works", async () => {
        const mine = sessionSummary({ name: "Mine" });
        const other = sessionSummary({ name: "Other" });
        bridge.listSessions.mockResolvedValue([mine, other]);

        const { rerender } = renderDrawer({ currentSessionId: mine.id, working: false });

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
                    <SessionDrawer
                        id="session-drawer"
                        endpoint="local"
                        currentSessionId={mine.id}
                        working
                        busy
                        onPick={() => undefined}
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

        renderDrawer();

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

        renderDrawer();

        const head = await screen.findByRole("button", { name: /work\/pie/ });
        expect(head).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(head);

        expect(head).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Pie work")).toBeNull();
        expect(screen.getByText("Other work")).toBeInTheDocument();
    });

    it("has a word for an empty directory and for a search that found nothing", async () => {
        renderDrawer();
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

        renderDrawer();

        expect(screen.getByText("Looking for sessions…")).toBeInTheDocument();
        expect(screen.queryByText("No sessions yet")).toBeNull();

        answer([]);
        expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    });

    it("holds every row still while a switch or a run is in the way", async () => {
        const picked = vi.fn();
        bridge.listSessions.mockResolvedValue([sessionSummary({ name: "Fix the parser" })]);

        renderDrawer({ busy: true, onPick: picked });

        const row = await screen.findByRole("button", { name: /Fix the parser/ });
        expect(row).toBeDisabled();
        fireEvent.click(row);
        expect(picked).not.toHaveBeenCalled();
    });

    it("says why the listing failed, in the words of the screen", async () => {
        bridge.listSessions.mockRejectedValue({
            type: "connection",
            message: "raw",
            error: { kind: "not_connected" },
        });

        renderDrawer();

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("There is no connection."));
    });

    it("asks the host again when the reader refreshes", async () => {
        renderDrawer();
        await screen.findByText("No sessions yet");
        expect(bridge.listSessions).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Refresh the session list" }));

        // The list is not stale on its own: a session file changes with no event to
        // say so, and this key is the only thing that asks again.
        await waitFor(() => expect(bridge.listSessions).toHaveBeenCalledTimes(2));
    });
});
