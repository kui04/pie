import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BranchSummary } from "@/routes/chat/transcript/entries/BranchSummary";

describe("BranchSummary", () => {
    it("draws the word alone, and opens the whole summary behind it", () => {
        render(<BranchSummary id="n1" body={"the other branch tried a regex\n\nand fell back"} />);

        expect(screen.getByText("Summary")).toBeInTheDocument();
        expect(screen.queryByText("and fell back")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Summary/ }));
        expect(screen.getByText("and fell back")).toBeInTheDocument();
    });
});
