/**
 * The bar's leading key: the way to the list, and what a press on it would do.
 *
 * It belongs to the window rather than to a session (`ChatScreen` draws it), so it stands
 * still when another conversation opens - which is what these tests hold it to, one state
 * of the list at a time.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";

function show(overrides: Partial<Parameters<typeof SidebarToggle>[0]> = {}) {
    return render(<SidebarToggle onToggleSessions={() => undefined} {...overrides} />);
}

describe("SidebarToggle", () => {
    it("carries the way to the session list, and hands a press on it out", () => {
        const toggled = vi.fn();
        show({ onToggleSessions: toggled });

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        expect(toggled).toHaveBeenCalledTimes(1);
    });

    it("says whether the list is out, where the column is the one it opens", () => {
        const { container } = show({ expanded: true });

        const key = screen.getByRole("button", { name: "Sessions" });
        expect(key).toHaveAttribute("aria-expanded", "true");
        // The icon says it too, and it says what a press would do: fold the column that is out.
        expect(container.querySelector(".lucide-panel-left-close")).not.toBeNull();
        expect(container.querySelector(".lucide-panel-left-open")).toBeNull();
    });

    it("promises no column where the list is a sheet instead", () => {
        const { container } = show();

        expect(screen.getByRole("button", { name: "Sessions" })).not.toHaveAttribute("aria-expanded");
        // The sheet is not out either, so a press opens it.
        expect(container.querySelector(".lucide-panel-left-open")).not.toBeNull();
    });
});
