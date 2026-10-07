import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UsagePopover } from "@/routes/chat/components/session/UsagePopover";
import { sessionStats } from "@/preview/fixtures";

const trigger = () => screen.getByRole("button", { name: /^Context usage/ });

function show(stats = sessionStats(), auto = false) {
    render(<UsagePopover id="session-header-usage" stats={stats} auto={auto} />);
}

describe("UsagePopover", () => {
    it("says what the ring stands for, and everything the session reports", () => {
        show();
        fireEvent.click(trigger());
        expect(screen.getByText("Context usage")).toBeTruthy();
        expect(screen.getByText("4.6%")).toBeTruthy();
        expect(screen.getByText("23k / 512k tokens")).toBeTruthy();
        expect(screen.getByText("↑12k ↓3.4k R184k W9.2k")).toBeTruthy();
        expect(screen.getByText("Session cost $0.45")).toBeTruthy();
        expect(screen.getByText("Messages")).toBeTruthy();
        expect(screen.getByText("12")).toBeTruthy();
        expect(screen.getByText("User messages")).toBeTruthy();
        expect(screen.getByText("4")).toBeTruthy();
        expect(screen.getByText("Assistant messages")).toBeTruthy();
        expect(screen.getByText("8")).toBeTruthy();
        expect(screen.getByText("Tool calls")).toBeTruthy();
        expect(screen.getByText("Tool results")).toBeTruthy();
        expect(screen.getAllByText("3")).toHaveLength(2);
    });

    it("marks a context that pi compacts on its own", () => {
        show(sessionStats(), true);
        fireEvent.click(trigger());
        expect(screen.getByText("23k / 512k tokens (auto)")).toBeTruthy();
    });

    it("carries the reading itself, since the bar shows the ring alone", () => {
        show();
        expect(trigger().getAttribute("aria-label")).toBe("Context usage 4.6%");
    });

    it("says the context is unknown rather than nothing", () => {
        show(sessionStats({ contextUsage: { tokens: null, contextWindow: 512000, percent: null } }));
        fireEvent.click(trigger());
        expect(screen.getByText("-- / 512k tokens")).toBeTruthy();
    });

    it("leaves out what a session has not spent, as pi's own footer does", () => {
        show(sessionStats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }));
        fireEvent.click(trigger());
        expect(screen.queryByText(/↑/)).toBeNull();
        expect(screen.queryByText(/Session cost/)).toBeNull();
    });

    it("colours a reading the way pi's footer colours the same number", () => {
        show(sessionStats({ contextUsage: { tokens: 420000, contextWindow: 512000, percent: 82.3 } }));
        expect(trigger().querySelector("circle:nth-of-type(2)")?.getAttribute("class")).toContain("stroke-warning");
    });

    it("alarms over a context that is nearly full", () => {
        show(sessionStats({ contextUsage: { tokens: 500000, contextWindow: 512000, percent: 97.7 } }));
        expect(trigger().querySelector("circle:nth-of-type(2)")?.getAttribute("class")).toContain("stroke-destructive");
    });
});
