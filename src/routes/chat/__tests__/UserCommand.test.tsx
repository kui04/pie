import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserCommand } from "@/routes/chat/transcript/entries/UserCommand";
import { presentExecution, presentRunningExecution } from "@/routes/chat/transcript/presentation";
import { bashExecution } from "@/preview/fixtures";

describe("UserCommand", () => {
    it("leads a command the reader ran with pi's own prompt", () => {
        render(<UserCommand id="e3" tool="bash" presentation={presentExecution(bashExecution("ls", "one\ntwo"))} />);

        expect(screen.getByText("$")).toBeInTheDocument();
        expect(screen.getByText("ls")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /ls/ }));
        const body = document.querySelector(String.raw`[data-slot="code-block-content"]`);
        expect(body).not.toBeNull();
        expect(body?.textContent).toContain("one");
        expect(body?.textContent).toContain("two");
        // A log scrolls until the reader asks for wrap.
        expect(body?.hasAttribute("data-wrap")).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
        expect(body?.hasAttribute("data-wrap")).toBe(true);
    });

    it("opens a command that runs while it runs, and folds it when it settles", async () => {
        const { rerender } = render(
            <UserCommand
                id="e3"
                tool="bash"
                presentation={presentRunningExecution({ command: "sleep 5", output: "one\n" })}
            />,
        );
        expect(screen.getByText("one")).toBeInTheDocument();
        expect(screen.getByLabelText("Running")).toBeInTheDocument();

        rerender(
            <UserCommand id="e3" tool="bash" presentation={presentExecution(bashExecution("sleep 5", "one\n"))} />,
        );
        await waitFor(() => expect(screen.queryByText("one")).toBeNull());
    });

    it("carries its own line under itself when it stands outside a fold", () => {
        render(
            <UserCommand id="e3" tool="bash" presentation={presentExecution(bashExecution("ls", "one\ntwo"))} quote />,
        );
        fireEvent.click(screen.getByRole("button", { name: /ls/ }));

        const line = document.querySelector("span.bg-divider");
        expect(line).not.toBeNull();
        expect(line?.closest("div.pl-8")).not.toBeNull();
    });
});
