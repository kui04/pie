import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CustomMessage } from "@/routes/chat/transcript/entries/CustomMessage";

describe("CustomMessage", () => {
    it("leads with the word its extension gave it", () => {
        render(<CustomMessage id="n1" label="Review" summary="two files miss coverage" body={null} />);

        expect(screen.getByText("Review")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("opens a longer message on its own row", () => {
        render(
            <CustomMessage
                id="n1"
                label="Review"
                summary="two files miss coverage"
                body={"two files miss coverage\n\nadd the missing tests"}
            />,
        );

        expect(screen.queryByText("add the missing tests")).toBeNull();
        expect(screen.queryByText("two files miss coverage")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /^Review$/ }));
        expect(screen.getByText("add the missing tests")).toBeInTheDocument();
    });
});
