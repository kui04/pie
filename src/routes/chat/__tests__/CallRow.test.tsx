import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CallRow } from "@/routes/chat/transcript/entries/CallRow";
import { presentCall } from "@/routes/chat/transcript/presentation";
import { toolResult } from "@/preview/fixtures";

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

    it("keeps a long tool name on one line, and truncates what it aimed at instead", () => {
        render(
            <CallRow
                id="e2-c1"
                tool="ollama_web_search"
                presentation={presentCall(
                    "ollama_web_search",
                    { query: "getting attributes", max_results: 5 },
                    toolResult("c1", "ollama_web_search", "hits"),
                )}
            />,
        );

        // The name takes the width it needs; the target takes what is left.
        const name = screen.getByText("Ollama Web Search");
        expect(name.className).toContain("whitespace-nowrap");
        expect(name.className).toContain("shrink-0");
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
        expect(document.querySelector(String.raw`[data-slot="scroll-area"]`)).not.toBeNull();
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

    it("opens a call that runs while it runs, and folds it when the result lands", async () => {
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
        await waitFor(() => expect(screen.queryByText("PASS so far")).toBeNull());
    });

    it("keeps a running call closed until it has a body", () => {
        render(
            <CallRow
                id="e2-c1"
                tool="bash"
                presentation={presentCall("bash", { command: "sleep 5" }, null, true, true)}
            />,
        );

        expect(screen.getByRole("button", { name: /sleep 5/ })).toHaveAttribute("aria-expanded", "false");
        expect(document.querySelector('[id$="-body"]')).toBeNull();
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

        // One pane holds the lines, and it wraps instead of scrolling sideways, so no
        // number ever slides out from under its line.
        expect(document.querySelectorAll(String.raw`[data-slot="code-block-content"]`)).toHaveLength(1);
        // The words wrap rather than run past the pane, so nothing ever passes under a number.
        expect(screen.getByText("kept").className).toContain("whitespace-pre-wrap");
        // A diff wraps until the reader asks it to scroll.
        const content = document.querySelector(String.raw`[data-slot="code-block-content"]`);
        expect(content?.hasAttribute("data-wrap")).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
        expect(content?.hasAttribute("data-wrap")).toBe(false);
    });
});
