import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CallRow } from "@/routes/chat/transcript/entries/CallRow";
import { presentCall, presentExecution } from "@/routes/chat/transcript/presentation";
import { bashExecution, toolResult } from "@/preview/fixtures";

describe("CallRow", () => {
    it("draws a call as one line: its word, what it aimed at, and pi's own clock", () => {
        render(
            <CallRow
                id="e2-c1"
                tool="bash"
                presentation={presentCall(
                    "bash",
                    { command: "pnpm test" },
                    toolResult("c1", "bash", "36 passed", { durationMs: 5200 }),
                )}
            />,
        );

        expect(screen.getByText("Bash")).toBeInTheDocument();
        expect(screen.getByText("pnpm test")).toBeInTheDocument();
        // pi measured the call, so the row says what the tool took, not what the window saw.
        expect(screen.getByText("5.2s")).toBeInTheDocument();
    });

    it("previews nothing, and shows the whole of what it produced when the reader asks", () => {
        render(
            <CallRow
                id="e2-c1"
                tool="edit"
                presentation={presentCall(
                    "edit",
                    { path: "/a.ts" },
                    toolResult("c1", "edit", "written", { details: { diff: "- 1 old\n+ 1 new" } }),
                )}
            />,
        );

        expect(screen.queryByText("new")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /\/a\.ts/ }));
        expect(screen.getByText("new")).toBeInTheDocument();
        expect(screen.getByText("old")).toBeInTheDocument();
    });

    it("marks a call that failed, and says what its result carried", () => {
        render(
            <CallRow
                id="e2-c1"
                tool="bash"
                presentation={presentCall(
                    "bash",
                    { command: "pnpm test" },
                    toolResult("c1", "bash", "boom", { isError: true, durationMs: 900 }),
                )}
            />,
        );

        expect(screen.getByLabelText("Failed")).toBeInTheDocument();
        expect(screen.getByText("0.9s")).toBeInTheDocument();
    });

    it("opens a call that runs while it runs, and folds it when the result lands", () => {
        const line = toolResult("c1", "bash", "PASS so far");
        const { rerender } = render(
            <CallRow
                id="e2-c1"
                tool="bash"
                presentation={presentCall("bash", { command: "pnpm test" }, line, true, true)}
            />,
        );
        expect(screen.getByText("PASS so far")).toBeInTheDocument();
        expect(screen.getByLabelText("Running")).toBeInTheDocument();

        rerender(<CallRow id="e2-c1" tool="bash" presentation={presentCall("bash", { command: "pnpm test" }, line)} />);
        expect(screen.queryByText("PASS so far")).toBeNull();
    });

    it("leads a command the reader ran with pi's own prompt", () => {
        render(<CallRow id="e3" tool="bash" presentation={presentExecution(bashExecution("ls", "one\ntwo"))} />);

        expect(screen.getByText("$")).toBeInTheDocument();
        expect(screen.getByText("ls")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /ls/ }));
        const body = screen.getByText("one").closest("div.flex");
        expect(body).not.toBeNull();
        expect(within(body as globalThis.HTMLElement).getByText("two")).toBeInTheDocument();
    });
});

describe("CallRow's numbered body", () => {
    it("numbers its lines without a sideways scroller, which is what keeps the numbers flush", () => {
        render(
            <CallRow
                id="e2-c1"
                tool="edit"
                presentation={presentCall(
                    "edit",
                    { path: "/a.ts" },
                    toolResult("c1", "edit", "written", { details: { diff: " 1 kept\n- 2 old\n+ 2 new" } }),
                )}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /\/a\.ts/ }));

        // A bar for a sideways scroll is what the words used to slide under the numbers for, and a
        // stuck number column can be drawn a pixel inside the pane, leaving a hairline of them
        // showing. A numbered body scrolls one way only.
        expect(document.querySelectorAll(String.raw`[data-slot="scroll-area-scrollbar"]`)).toHaveLength(1);
        // The words wrap rather than run past the pane, so nothing ever passes under a number.
        expect(screen.getByText("kept").className).toContain("whitespace-pre-wrap");
    });
});
