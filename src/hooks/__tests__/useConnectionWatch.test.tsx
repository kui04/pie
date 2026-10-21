/**
 * The ear of the app for a lost reach: Rust's event reaches the machine, the machine's answer
 * reaches the bridge, and leaving goes to the gate.
 *
 * The bridge answers what a test tells it to. Nothing here reaches Tauri.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, Link } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type * as Bridge from "@/lib/bridge";
import { ConnectionLostOverlay } from "@/routes/connect/ConnectionLostOverlay";
import { reportReachFailure } from "@/lib/query";
import { useConnectionWatch } from "@/hooks/useConnectionWatch";
import { queryDefaults } from "@/lib/query";

const fake = vi.hoisted(() => ({
    getConnection: vi.fn<() => Promise<Bridge.ConnectionInfo | null>>(),
    reconnect: vi.fn<() => Promise<Bridge.ConnectionInfo>>(),
    onConnectionState:
        vi.fn<(id: string, onState: (state: Bridge.ConnectionState) => void) => Promise<Bridge.Unsubscribe>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...fake,
}));

const INFO: Bridge.ConnectionInfo = {
    id: "main",
    endpoint: "kui04@localhost:22",
    sessions: [],
    open: true,
};

/**
 * The app's own shape: the boundary stands above the pages, watching the reach, and the page
 * under it is whichever route is up.
 */
function Boundary({ children }: { children: ReactNode }) {
    const watch = useConnectionWatch();
    return (
        <>
            {children}
            <ConnectionLostOverlay
                state={watch.state}
                endpoint={watch.endpoint}
                message={watch.message}
                onRetry={watch.retry}
                onLeave={watch.leave}
            />
        </>
    );
}

describe("the reach to the machine, watched by the app", () => {
    let client: QueryClient;
    let heard: (state: Bridge.ConnectionState) => void;

    beforeEach(() => {
        vi.clearAllMocks();
        fake.getConnection.mockResolvedValue(INFO);
        fake.reconnect.mockResolvedValue(INFO);
        fake.onConnectionState.mockImplementation(async (_id, onState) => {
            heard = onState;
            return () => undefined;
        });
        client = new QueryClient(queryDefaults);
    });

    function show(start = "/chat") {
        render(
            <QueryClientProvider client={client}>
                <MemoryRouter initialEntries={[start]}>
                    <Boundary>
                        <Routes>
                            <Route path="/chat" element={<p>the workspace</p>} />
                            {/* The gate: the way to the workspace stands for the dial that a
                                person makes there, which is what makes a connection exist. */}
                            <Route
                                path="/"
                                element={
                                    <>
                                        <p>the gate</p>
                                        <Link to="/chat">the workspace</Link>
                                    </>
                                }
                            />
                        </Routes>
                    </Boundary>
                </MemoryRouter>
            </QueryClientProvider>,
        );
    }

    /** The end of the reach, as Rust announces it. */
    async function loseTheReach() {
        show();
        await waitFor(() => expect(fake.onConnectionState).toHaveBeenCalled());
        act(() => heard({ type: "ended" }));
        await screen.findByRole("alertdialog");
    }

    it("does not bounce back to the gate when the connection arrives after the read said none", async () => {
        // The window opens at the gate with no connection, and the boundary is mounted for the
        // whole run: its answer says none, and the dial a person makes there is what changes it.
        fake.getConnection.mockResolvedValue(null);
        show("/");
        await waitFor(() => expect(fake.getConnection).toHaveBeenCalled());
        fake.getConnection.mockResolvedValue(INFO);

        await userEvent.click(await screen.findByRole("link", { name: "the workspace" }));

        // A window that stays: the cached answer of the moment before the dial is not the
        // truth, and a boundary that trusted it would send the window straight back.
        expect(await screen.findByText("the workspace")).toBeInTheDocument();
        expect(screen.queryByText("the gate")).not.toBeInTheDocument();
    });

    it("says nothing while the reach answers", async () => {
        show();

        await waitFor(() => expect(fake.getConnection).toHaveBeenCalled());
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("stands over the page when the reach ends, naming the machine", async () => {
        await loseTheReach();

        expect(screen.getByText("The connection to kui04@localhost:22 was lost")).toBeInTheDocument();
    });

    it("veils the window on the first failed read, without waiting for a tick", async () => {
        show();
        await waitFor(() => expect(fake.getConnection).toHaveBeenCalled());
        // The reach answered, and then the link went: the reads that follow fail, and Rust is
        // asked what the reach is doing now.
        fake.getConnection.mockResolvedValue({ ...INFO, open: false });

        act(() => reportReachFailure());

        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        expect(fake.getConnection.mock.calls.length).toBeGreaterThan(1);
    });

    it("keeps the veil over an answer that says the reach is still closed", async () => {
        await loseTheReach();
        fake.getConnection.mockResolvedValue({ ...INFO, open: false });

        act(() => reportReachFailure());

        await waitFor(() => expect(fake.getConnection.mock.calls.length).toBeGreaterThan(1));
        // A closed answer is not the reach back: only an open one lifts the veil.
        expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    it("dials again on a press, and is gone once a connection is held", async () => {
        await loseTheReach();

        await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));

        await waitFor(() => expect(fake.reconnect).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("leaves for the gate, and stays away once it is there", async () => {
        await loseTheReach();

        await userEvent.click(screen.getByRole("button", { name: "Go to the gate" }));

        expect(await screen.findByText("the gate")).toBeInTheDocument();
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
});
