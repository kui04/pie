import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Compaction } from "@/routes/chat/transcript/entries/Compaction";

describe("Compaction", () => {
    it("draws the word and the size it cut from, and opens the summary behind it", () => {
        render(
            <Compaction
                id="n1"
                tokensBefore={18432}
                body={"we made the parser skip empty lines\n\nand then stopped"}
            />,
        );

        expect(screen.getByText("Compaction")).toBeInTheDocument();
        expect(screen.getByText("Compacted from 18,432 tokens")).toBeInTheDocument();
        expect(screen.queryByText("and then stopped")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Compaction/ }));
        expect(screen.getByText("and then stopped")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /Compaction/ }));
        expect(screen.queryByText("and then stopped")).toBeNull();
    });

    it("carries its own line under itself when it stands outside a fold", () => {
        render(<Compaction id="n1" tokensBefore={100} body={"first line\n\nsecond line"} quote />);
        fireEvent.click(screen.getByRole("button", { name: /Compaction/ }));

        const line = document.querySelector("span.bg-divider");
        expect(line).not.toBeNull();
        expect(line?.closest("div.pl-8")).not.toBeNull();
    });
});
