import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "@/components/TitleBar";
import type * as Bridge from "@/lib/bridge";

/**
 * The bar decides nothing: every key hands a window event on and the window's
 * own answer is what comes back. So these are about the handoff, and about the
 * one thing the bar does reflect — whether the window is maximized.
 */

const windowControls = vi.hoisted(() => ({
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
}));

/** Reports a maximized window, and lets a test change its mind. */
const report = vi.hoisted(() => ({ current: false }));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    windowControls,
    watchWindow: async (check: (isMaximized: boolean) => void): Promise<Bridge.Unsubscribe> => {
        check(report.current);
        return () => undefined;
    },
}));

beforeEach(() => {
    report.current = false;
    for (const fn of Object.values(windowControls)) fn.mockClear();
});

afterEach(cleanup);

describe("TitleBar", () => {
    it("hands each key's event to the window", async () => {
        const user = userEvent.setup();
        render(<TitleBar />);

        await user.click(screen.getByRole("button", { name: "Minimize" }));
        await user.click(screen.getByRole("button", { name: "Maximize" }));
        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(windowControls.minimize).toHaveBeenCalledOnce();
        expect(windowControls.toggleMaximize).toHaveBeenCalledOnce();
        expect(windowControls.close).toHaveBeenCalledOnce();
    });

    it("names the middle key for what it will do, not for the window", () => {
        render(<TitleBar />);

        expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    });

    it("swaps the middle key once the window says it is maximized", () => {
        report.current = true;
        render(<TitleBar />);

        expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Maximize" })).not.toBeInTheDocument();
        // Still the same key doing the same thing: the window is what toggles.
        expect(windowControls.toggleMaximize).not.toHaveBeenCalled();
    });

    it("carries no title, because the session's name belongs to the bar below", () => {
        render(<TitleBar />);

        // Nothing between the mark and the keys but the keys.
        expect(screen.getAllByRole("button")).toHaveLength(3);
    });

    it("keeps every key at the 24px hit area the design fixes", () => {
        render(<TitleBar />);

        for (const name of ["Minimize", "Maximize", "Close"]) {
            expect(screen.getByRole("button", { name }).className).toContain("size-6");
        }
    });

    it("draws no mark at all rather than a broken one", () => {
        const { container } = render(<TitleBar />);

        // The repo has no mark asset yet, and an invented one would be worse
        // than an empty slot.
        expect(container.querySelector("#title-bar-mark")).toBeNull();
    });

    it("shows the mark when there is one to show", () => {
        const { container } = render(<TitleBar mark="/pi.svg" />);
        const mark = container.querySelector<HTMLImageElement>("#title-bar-mark");

        expect(mark?.getAttribute("src")).toBe("/pi.svg");
        // Decorative: the bar names nothing, so a screen reader has nothing to
        // read out twice.
        expect(mark?.alt).toBe("");
    });

    it("keeps the keys at the end of the row with or without a mark", () => {
        const { container, rerender } = render(<TitleBar />);
        const keys = () => container.querySelector("#title-bar-keys")?.className ?? "";

        // `space-between` alone only reaches the right-hand end while something
        // is on the left to push it there, and the mark is an asset this repo
        // does not have yet — so the keys ask for that end themselves.
        expect(keys()).toContain("ms-auto");
        expect(container.querySelector("#title-bar-root")?.className).not.toContain("justify-between");

        rerender(<TitleBar mark="/pi.svg" />);
        expect(keys()).toContain("ms-auto");
    });

    it("puts the whole row in one piece, so the window can be dragged by it", () => {
        const { container } = render(<TitleBar />);

        // Tauri's drag region only covers the element it is applied to, so it
        // belongs on the bar itself rather than on a spacer inside it.
        expect(container.querySelector("#title-bar-root")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    });
});
