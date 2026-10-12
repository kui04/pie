import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ToolResultMessage } from "@/lib/rpc-protocol";
import { ToolResultCard } from "@/routes/chat/transcript/entries/ToolResultCard";
import { presentCall } from "@/routes/chat/transcript/tool-presentation";

const answered = (text: string, overrides: Partial<Omit<ToolResultMessage, "role">> = {}): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
    ...overrides,
});

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("ToolResultCard", () => {
    it("shows the end of a log while it is closed, and all of it when opened", async () => {
        const result = answered(lines(10));

        render(<ToolResultCard id="e1" presentation={presentCall("bash", { command: "ls" }, result)} />);

        expect(screen.getByText(/line 10/)).toBeInTheDocument();
        expect(screen.queryByText(/line 1$/)).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /bash/ }));

        expect(screen.getByText(/^line 1$/)).toBeInTheDocument();
    });

    it("shows the beginning of a file while it is closed", () => {
        const result = answered(lines(10), { toolName: "read" });

        render(<ToolResultCard id="e1" presentation={presentCall("read", { path: "/a.ts", offset: 12 }, result)} />);

        expect(screen.getByText("line 1")).toBeInTheDocument();
        expect(screen.queryByText("line 10")).not.toBeInTheDocument();
        // The lines are numbered from where the read started, which the call says.
        expect(screen.getByText("12")).toBeInTheDocument();
        expect(screen.getByText("14")).toBeInTheDocument();
    });

    it("splits a diff line into the mark, the number and the text", () => {
        const diff = ["- 1 const a = 1;", "+ 1 const a = 2;", "  2 const b = 3;"].join("\n");
        const result = answered("the file was written", {
            toolName: "edit",
            details: { diff },
        });

        render(<ToolResultCard id="e1" presentation={presentCall("edit", { path: "/a.ts" }, result)} />);

        // The text of a line is of its own, and the mark of the line carries the
        // colour: a diff of a large file is still read in the ordinary colour.
        expect(screen.getByText("const a = 2;")).toBeInTheDocument();
        expect(screen.getByText("+").className).toContain("text-success");
        expect(screen.getByText("-").className).toContain("text-destructive");
        // The gutter holds the number and then the mark of every line, and it is
        // a column of its own beside the text - not inside the scroller, so that
        // nothing about the sideways scroll can move it.
        const lines = screen.getByText("const a = 1;").closest("[id$='-lines']");
        const gutter = lines?.previousElementSibling;
        expect(lines).not.toBeNull();
        expect(gutter?.id).toBe("e1-gutter");
        expect(gutter?.closest(".overflow-x-auto")).toBeNull();
        expect(gutter?.textContent).toBe("1-1+2 ");
        expect(screen.getByText("const b = 3;")).toBeInTheDocument();
    });

    it("waits for a result that has not come", () => {
        render(<ToolResultCard id="e1" presentation={presentCall("bash", { command: "sleep 100" }, null)} />);

        expect(screen.getByLabelText("Waiting")).toBeInTheDocument();
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("shows a failed result as its error", () => {
        const result = answered("no such file", { isError: true, toolName: "read" });

        render(<ToolResultCard id="e1" presentation={presentCall("read", { path: "/missing" }, result)} />);

        expect(screen.getByLabelText("Failed")).toBeInTheDocument();
        expect(screen.getByText("no such file")).toBeInTheDocument();
    });

    it("times a call that is running, and stops when it settles", async () => {
        const running = presentCall("bash", { command: "pnpm test" }, null, true);
        const { rerender } = render(<ToolResultCard id="e1" presentation={running} />);

        expect(screen.getByLabelText("Running")).toBeInTheDocument();
        expect(await screen.findByText(/Elapsed/)).toBeInTheDocument();

        rerender(
            <ToolResultCard id="e1" presentation={presentCall("bash", { command: "pnpm test" }, answered("ok"))} />,
        );

        expect(await screen.findByText(/Took/)).toBeInTheDocument();
        expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
    });

    it("shows no duration for a call a transcript only replays", () => {
        // The call settled before this card was ever drawn, so no clock exists:
        // pi's own cards behave the same way on a rebuild.
        render(<ToolResultCard id="e1" presentation={presentCall("bash", { command: "pnpm test" }, answered("ok"))} />);

        expect(screen.queryByText(/Elapsed|Took/)).not.toBeInTheDocument();
    });

    it("says where a truncated output went", () => {
        const result = answered("the end", {
            details: {
                truncation: { truncated: true, outputLines: 200, totalLines: 9000 },
                fullOutputPath: "/tmp/out",
            },
        });

        render(<ToolResultCard id="e1" presentation={presentCall("bash", { command: "cat big" }, result)} />);

        expect(screen.getByText("Truncated: 200 of 9000 lines")).toBeInTheDocument();
        expect(screen.getByText("Full output: /tmp/out")).toBeInTheDocument();
    });

    it("draws a command the reader ran with its prompt and its exit code", () => {
        render(
            <ToolResultCard
                id="e1"
                presentation={{
                    title: "$",
                    detail: "ls /nowhere",
                    tone: "user-run",
                    status: "failed",
                    body: { kind: "log", lines: ["not found"] },
                    notes: [{ text: "(exit 2)", tone: "error" }],
                }}
            />,
        );

        expect(screen.getByText("$")).toBeInTheDocument();
        expect(screen.getByText("ls /nowhere")).toBeInTheDocument();
        expect(screen.getByText("(exit 2)")).toBeInTheDocument();
    });

    it("offers no way to open a card that holds nothing more", () => {
        render(<ToolResultCard id="e1" presentation={presentCall("read", { path: "/a.ts" }, answered("one line"))} />);

        expect(screen.queryByText(/Expand to view/)).not.toBeInTheDocument();
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
});
