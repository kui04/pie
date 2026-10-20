/**
 * The actions of one conversation: rename, fork, copy, delete, detach.
 *
 * The commands are stubbed here, and the session is a chart of its own, so a test says
 * what pi answers and what the screen asks of it without a Tauri runtime.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createActor } from "xstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { Event as SessionRecord } from "@/lib/rpc-protocol";
import { queryDefaults } from "@/lib/query";
import { sessionMachine, type SessionDeps } from "@/machines/session.machine";
import type { SessionRef } from "@/lib/sessions";
import { SessionMenu } from "@/routes/chat/menu/SessionMenu";
import { sessionState } from "@/preview/fixtures";

type Call = (...args: never[]) => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    getState: vi.fn<Call>(),
    setSessionName: vi.fn<Call>(),
    getForkMessages: vi.fn<Call>(),
    forkSession: vi.fn<Call>(),
    cloneSession: vi.fn<Call>(),
    detachSession: vi.fn<Call>(),
    deleteSession: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

const SESSION = "main:1";

/** The deps of a session chart whose listeners never open: this screen reads the cache. */
const idle: SessionDeps = {
    listen: () => new Promise<never>(() => undefined),
    reRead: () => undefined,
    notice: () => undefined,
};

function renderMenu(working = false, isMobile?: boolean) {
    const client = new QueryClient(queryDefaults);
    const machine = createActor(sessionMachine, { input: idle }).start();
    if (working) machine.send({ type: "RECORD", at: 1, record: { type: "agent_start" } as SessionRecord });
    const onClose = vi.fn();
    const onGone = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <Harness machine={machine} onClose={onClose} onGone={onGone} isMobile={isMobile} />
        </QueryClientProvider>,
    );
    return { machine, onClose, onGone };
}

/** The popup's open state is the caller's, as it is in `ChatScreen`: the test presses the key it draws. */
function Harness({
    machine,
    onClose,
    onGone,
    isMobile,
}: {
    machine: SessionRef;
    onClose: () => void;
    onGone: () => void;
    isMobile?: boolean;
}) {
    const [open, setOpen] = useState(false);
    return (
        <SessionMenu
            session={SESSION}
            machine={machine}
            endpoint="local"
            open={open}
            onOpenChange={setOpen}
            onClose={onClose}
            onGone={onGone}
            isMobile={isMobile}
        />
    );
}

function openMenu() {
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
}

describe("the session menu", () => {
    beforeEach(() => {
        for (const each of Object.values(bridge)) each.mockReset();
        bridge.getState.mockResolvedValue(sessionState());
    });

    it("offers the actions of the conversation, once the file is known", async () => {
        renderMenu();
        openMenu();

        expect(await screen.findByRole("menuitem", { name: "Rename" })).not.toHaveAttribute("aria-disabled", "true");
        expect(screen.getByRole("menuitem", { name: "Fork" })).not.toHaveAttribute("aria-disabled", "true");
        expect(screen.getByRole("menuitem", { name: "Clone" })).not.toHaveAttribute("aria-disabled", "true");
        expect(screen.getByRole("menuitem", { name: "Detach" })).not.toHaveAttribute("aria-disabled", "true");
        // Deleting needs the file, which the state read answers with.
        await waitFor(() =>
            expect(screen.getByRole("menuitem", { name: "Delete" })).not.toHaveAttribute("aria-disabled", "true"),
        );
    });

    it("centres each row's glyph in its slot", async () => {
        renderMenu();
        openMenu();

        const row = await screen.findByRole("menuitem", { name: "Rename" });
        const slot = row.querySelector('[data-slot="icon"]')?.parentElement;
        for (const each of ["size-4", "items-center", "justify-center"]) {
            expect(slot?.classList.contains(each)).toBe(true);
        }
    });

    it("marks deleting as destructive, apart from detaching", async () => {
        renderMenu();
        openMenu();

        expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute("data-variant", "destructive");
        expect(screen.getByRole("menuitem", { name: "Detach" })).toHaveClass("text-warning");
    });

    it("keeps fork and copy out of reach while a run streams", async () => {
        renderMenu(true);
        openMenu();

        expect(await screen.findByRole("menuitem", { name: "Fork" })).toHaveAttribute("aria-disabled", "true");
        expect(screen.getByRole("menuitem", { name: "Clone" })).toHaveAttribute("aria-disabled", "true");
        // The name, the file and the process can be reached at any time.
        expect(screen.getByRole("menuitem", { name: "Rename" })).not.toHaveAttribute("aria-disabled", "true");
        expect(screen.getByRole("menuitem", { name: "Detach" })).not.toHaveAttribute("aria-disabled", "true");
    });

    it("copies the conversation into a new branch", async () => {
        bridge.cloneSession.mockResolvedValue({ cancelled: false });
        const { onGone } = renderMenu();
        openMenu();

        fireEvent.click(await screen.findByRole("menuitem", { name: "Clone" }));

        await waitFor(() => expect(bridge.cloneSession).toHaveBeenCalledWith(SESSION));
        expect(onGone).not.toHaveBeenCalled();
    });

    it("forks from the message that was picked", async () => {
        bridge.getForkMessages.mockResolvedValue([{ entryId: "e1", text: "first words" }]);
        bridge.forkSession.mockResolvedValue({ text: "first words", cancelled: false });
        renderMenu();
        openMenu();

        fireEvent.click(await screen.findByRole("menuitem", { name: "Fork" }));
        fireEvent.click(await screen.findByRole("button", { name: "first words" }));

        await waitFor(() => expect(bridge.forkSession).toHaveBeenCalledWith(SESSION, "e1"));
    });

    it("renames the conversation from the name pi holds", async () => {
        bridge.setSessionName.mockResolvedValue(undefined);
        renderMenu();
        openMenu();

        fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
        const field = await screen.findByLabelText("Name");
        expect(field).toHaveValue("Fix the parser");

        fireEvent.change(field, { target: { value: "Rewrite the parser" } });
        fireEvent.click(screen.getByRole("button", { name: "Rename" }));

        await waitFor(() => expect(bridge.setSessionName).toHaveBeenCalledWith(SESSION, "Rewrite the parser"));
    });

    it("ends the process before the file goes", async () => {
        bridge.detachSession.mockResolvedValue(undefined);
        bridge.deleteSession.mockResolvedValue(undefined);
        const { onClose, onGone } = renderMenu();
        openMenu();

        const row = await screen.findByRole("menuitem", { name: "Delete" });
        await waitFor(() => expect(row).not.toHaveAttribute("aria-disabled", "true"));
        fireEvent.click(row);
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

        await waitFor(() => expect(bridge.deleteSession).toHaveBeenCalledWith(sessionState().sessionFile));
        expect(bridge.detachSession).toHaveBeenCalledWith(SESSION);
        expect(onGone).toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("gives the conversation up without ending a process that is already gone", async () => {
        const { onClose } = renderMenu();
        openMenu();

        fireEvent.click(await screen.findByRole("menuitem", { name: "Detach" }));

        expect(onClose).toHaveBeenCalled();
    });

    it("draws its sheets on a phone", async () => {
        bridge.setSessionName.mockResolvedValue(undefined);
        renderMenu(false, true);
        openMenu();

        fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

        expect(await screen.findByLabelText("Name")).toBeInTheDocument();
        expect(document.querySelector('[data-slot="drawer-popup"]')).not.toBeNull();
        expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    });
});
