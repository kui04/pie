import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { sessionStats } from "@/preview/fixtures";

function show(overrides: Partial<Parameters<typeof SessionTopbar>[0]> = {}) {
    return render(
        <SessionTopbar
            name="Fix the parser"
            cwd="/home/kui/Projects/pie"
            stats={sessionStats()}
            auto={false}
            {...overrides}
        />,
    );
}

describe("SessionTopbar", () => {
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
});
