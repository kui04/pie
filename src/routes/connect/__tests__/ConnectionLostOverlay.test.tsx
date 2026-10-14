/**
 * The overlay of a lost link: what it says, what it offers, and what the keyboard does with
 * it.
 *
 * It is built on Radix's dialog, so these tests read it the way a person does: the role
 * `alertdialog`, the two named buttons, and Escape.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionLostOverlay, type ConnectionLostOverlayProps } from "@/routes/connect/ConnectionLostOverlay";

function show(overrides: Partial<ConnectionLostOverlayProps> = {}) {
    const onRetry = vi.fn();
    const onLeave = vi.fn();
    const props: ConnectionLostOverlayProps = {
        state: "lost",
        endpoint: "kui04@localhost:22",
        message: null,
        onRetry,
        onLeave,
        ...overrides,
    };
    render(<ConnectionLostOverlay {...props} />);
    return { onRetry, onLeave };
}

describe("the overlay of a lost link", () => {
    it("names the machine that went away, and offers to reach it again", async () => {
        const { onRetry } = show();

        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        expect(screen.getByText("The connection to kui04@localhost:22 was lost")).toBeInTheDocument();
        expect(screen.getByText(/kept the way it reached kui04@localhost:22/)).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("can leave the workspace for the gate", async () => {
        const { onLeave } = show();

        await userEvent.click(await screen.findByRole("button", { name: "Go to the gate" }));

        expect(onLeave).toHaveBeenCalledTimes(1);
    });

    it("takes Escape as the gate, and never as a silent dismissal", async () => {
        const { onLeave } = show();

        await screen.findByRole("alertdialog");
        await userEvent.keyboard("{Escape}");

        expect(onLeave).toHaveBeenCalledTimes(1);
    });

    it("says a dial is under way, and does not offer a second one", async () => {
        show({ state: "retrying" });

        expect(await screen.findByText("Trying again…")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reconnecting" })).toBeDisabled();
    });

    it("says what a dial that failed said, and keeps the offer", async () => {
        show({ state: "failed", message: "the host never answered" });

        expect(await screen.findByText("the host never answered")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    });

    it("is not on screen while the reach is there", () => {
        show({ state: "held" });

        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("stays away while a person is at the gate", () => {
        show({ state: "left" });

        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
});
