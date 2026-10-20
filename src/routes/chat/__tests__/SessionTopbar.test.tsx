import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";

function show(overrides: Partial<Parameters<typeof SessionTopbar>[0]> = {}) {
    return render(<SessionTopbar name="Fix the parser" cwd="/home/kui/Projects/pie" {...overrides} />);
}

describe("SessionTopbar", () => {
    it("says what the session is called", () => {
        show();
        expect(screen.getByText("Fix the parser")).toBeTruthy();
    });

    it("takes the words that opened the session before the directory", () => {
        show({ name: null, firstMessage: "Read package.json and run git status" });
        expect(screen.getByText("Read package.json and run git status")).toBeTruthy();
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

    it("does not open a preview card from the bar", () => {
        const { container } = show();
        expect(container.querySelector('[data-slot="hover-card-trigger"]')).toBeNull();
    });
});
