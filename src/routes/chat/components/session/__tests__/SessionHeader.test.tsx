import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionHeader } from "@/routes/chat/components/session/SessionHeader";
import { sessionStats } from "@/preview/fixtures";

function show(overrides: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
    return render(
        <SessionHeader
            name="Fix the parser"
            cwd="/home/kui/Projects/pie"
            stats={sessionStats()}
            auto={false}
            onToggleSessions={() => undefined}
            {...overrides}
        />,
    );
}

describe("SessionHeader", () => {
    it("says what the session is called, under the ring of its usage", () => {
        const { container } = show();
        expect(screen.getByText("Fix the parser")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Context usage 4.6%" })).toBeTruthy();
        // The track, and the arc of the reading.
        expect(container.querySelectorAll("circle")).toHaveLength(2);
    });

    it("falls back to the directory, the way pi's own title does", () => {
        show({ name: null });
        expect(screen.getByText("pie")).toBeTruthy();
        show({ name: "", cwd: "C:\\Users\\kui" });
        expect(screen.getByText("kui")).toBeTruthy();
    });

    it("says nothing of a session with no directory either", () => {
        show({ name: null, cwd: null });
        expect(screen.getByText("Untitled")).toBeTruthy();
    });

    it("draws the track alone while pi does not know the context", () => {
        const { container } = show({
            stats: sessionStats({ contextUsage: { tokens: null, contextWindow: 512000, percent: null } }),
        });
        expect(screen.getByRole("button", { name: "Context usage" })).toBeTruthy();
        expect(container.querySelectorAll("circle")).toHaveLength(1);
    });

    it("shows a ring with nothing in it before the first read answers", () => {
        const { container } = show({ stats: null });
        expect(screen.getByRole("button", { name: "Context usage" })).toBeTruthy();
        expect(container.querySelectorAll("circle")).toHaveLength(1);
    });

    it("carries the way to the session list, and hands a press on it out", () => {
        const toggled = vi.fn();
        show({ onToggleSessions: toggled });

        fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
        expect(toggled).toHaveBeenCalledTimes(1);
    });

    it("says whether the list is out, where the column is the one it opens", () => {
        show({ expanded: true });
        expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute("aria-expanded", "true");
    });

    it("promises no column where the list is a sheet instead", () => {
        show();
        expect(screen.getByRole("button", { name: "Sessions" })).not.toHaveAttribute("aria-expanded");
    });
});
