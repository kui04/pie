import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { ThinkingLevelPicker, type ThinkingLevelPickerProps } from "@/routes/chat/composer/ThinkingLevelPicker";

type Call = (...args: unknown[]) => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    getAvailableThinkingLevels: vi.fn<Call>(),
    setThinkingLevel: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/**
 * The key with a client above it. Whether the popup is open is the caller's state, so
 * this holds it the way the composer does; a click on the key opens the popup.
 */
function renderPicker(props: Partial<ThinkingLevelPickerProps> = {}) {
    const client = new QueryClient(queryDefaults);
    function Harness() {
        const [open, setOpen] = useState(false);
        return <ThinkingLevelPicker session="main:1" current={null} open={open} onOpenChange={setOpen} {...props} />;
    }
    const view = render(
        <QueryClientProvider client={client}>
            <Harness />
        </QueryClientProvider>,
    );
    return { ...view, client };
}

beforeEach(() => {
    vi.clearAllMocks();
    bridge.getAvailableThinkingLevels.mockResolvedValue({ levels: ["off", "low", "high"] });
    bridge.setThinkingLevel.mockResolvedValue(undefined);
});

describe("the thinking level of the session", () => {
    it("holds the shape of the list while the levels are on their way", async () => {
        const user = userEvent.setup();
        // A read that never answers: the popup is opened before the levels are here.
        bridge.getAvailableThinkingLevels.mockReturnValue(new Promise(() => undefined));

        renderPicker({ current: "low" });
        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));

        expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
        expect(screen.getByRole("status", { name: "Loading the thinking levels" })).toBeInTheDocument();
        expect(screen.queryAllByRole("option")).toEqual([]);
    });

    it("says what happened when the levels cannot be read", async () => {
        const user = userEvent.setup();
        bridge.getAvailableThinkingLevels.mockRejectedValue(new Error("the session is gone"));

        renderPicker({ current: "low" });
        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));

        expect(await screen.findByText("Could not read the thinking levels.")).toBeInTheDocument();
        expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
    });

    it("sets the level that was chosen", async () => {
        const user = userEvent.setup();
        const { client } = renderPicker({ current: "off" });
        client.setQueryData(["session", "main:1", "state"], { sessionId: "0193" });

        expect(screen.getByRole("button", { name: "Choose the thinking level" })).toHaveTextContent("off");
        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));
        await user.click(await screen.findByRole("option", { name: "high" }));

        await waitFor(() => expect(bridge.setThinkingLevel).toHaveBeenCalledWith("main:1", "high"));
        expect(client.getQueryState(["session", "main:1", "state"])?.isInvalidated).toBe(true);
    });

    it("puts aria-selected on the row the light is on, not on the level in use", async () => {
        const user = userEvent.setup();
        renderPicker({ current: "low" });

        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));
        const list = await screen.findByRole("listbox", { name: "Choose the thinking level" });
        const options = screen.getAllByRole("option");
        // Nothing is lit: the level in use wears its check and no light of its own.
        for (const option of options) expect(option).toHaveAttribute("aria-selected", "false");
        expect(options[1]).toContainElement(screen.getByLabelText("In use"));

        // The pointer moves the light, and the selection with it.
        fireEvent.mouseMove(options[2]!);
        expect(options[2]).toHaveAttribute("aria-selected", "true");
        expect(options[1]).toHaveAttribute("aria-selected", "false");
        expect(options[1]).toContainElement(screen.getByLabelText("In use"));

        // Leaving the list takes the light away again, and the keyboard has not moved it.
        fireEvent.mouseLeave(list);
        for (const option of options) expect(option).toHaveAttribute("aria-selected", "false");
    });

    it("does not call for the level that is already in use", async () => {
        const user = userEvent.setup();
        renderPicker({ current: "low" });

        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));
        // The row in use carries its check, which is part of its name.
        await user.click(await screen.findByRole("option", { name: /low/ }));

        expect(bridge.setThinkingLevel).not.toHaveBeenCalled();
    });
});
