import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Skill } from "@/routes/chat/transcript/entries/Skill";

describe("Skill", () => {
    it("draws a skill of one line as text, not a button", () => {
        render(<Skill id="n1" summary="The skill `release-notes` ran." body={null} />);

        expect(screen.getByText("Skill")).toBeInTheDocument();
        expect(screen.getByText("The skill `release-notes` ran.")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("opens a longer skill on its own row, and folds it again", async () => {
        render(
            <Skill
                id="n1"
                summary="The skill `release-notes` ran."
                body={"The skill `release-notes` ran.\n\nIt wrote three entries."}
            />,
        );

        expect(screen.queryByText("It wrote three entries.")).toBeNull();
        // The header is the word alone: no line of the body reads on it.
        expect(screen.queryByText("The skill `release-notes` ran.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /^Skill$/ }));
        expect(screen.getByText("It wrote three entries.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /^Skill$/ }));
        await waitFor(() => expect(screen.queryByText("It wrote three entries.")).toBeNull());
    });
});
