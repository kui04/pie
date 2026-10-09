import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { assistant, text, thinking, toolCall, toolResult } from "@/preview/fixtures";
import { AssistantMessage } from "@/routes/chat/components/entries/AssistantMessage";
import type { LiveCall } from "@/lib/stream";
import type { AssistantMessage as AssistantMessageData, ToolResultMessage } from "@/lib/protocol";

const results = (...answered: ToolResultMessage[]) => new Map(answered.map((result) => [result.toolCallId, result]));

describe("AssistantMessage", () => {
    /** What a run streamed for one call, by call id. */
    const calls = (...streamed: Array<[string, LiveCall]>) => ({
        calls: new Map(streamed),
        retrying: false,
    });

    const message = (content: AssistantMessageData["content"], overrides: Partial<AssistantMessageData> = {}) =>
        assistant(content, overrides) as AssistantMessageData;

    it("says that the model is at work while the turn is unsettled", () => {
        const running = message([thinking("looking at the parser"), toolCall("c1", "bash", { command: "pnpm test" })], {
            stopReason: "pending",
        });

        render(<AssistantMessage id="e1" message={running} results={new Map()} />);

        // The thought is still arriving, and the call has no answer yet. The line that
        // says the run is at work belongs to the run, not to this message.
        expect(screen.getByText("Thinking…")).toBeInTheDocument();
        expect(screen.getByLabelText("Running")).toBeInTheDocument();
        expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    });

    it("says nothing about work when the turn has settled", () => {
        const settled = message([thinking("looking at the parser"), toolCall("c1", "bash", { command: "pnpm test" })]);

        render(<AssistantMessage id="e1" message={settled} results={new Map()} />);

        expect(screen.getByText("Thoughts")).toBeInTheDocument();
        expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
        // No answer ever came, and the turn is over: the call waits.
        expect(screen.getByLabelText("Waiting")).toBeInTheDocument();
    });
    it("says that a truncated answer was truncated, whatever it called", () => {
        const truncated = message([toolCall("c1", "read", { path: "/a.ts" })], { stopReason: "length" });

        render(<AssistantMessage id="e1" message={truncated} results={new Map()} />);

        expect(screen.getByText("Response was truncated before completion.")).toBeInTheDocument();
    });

    it("leaves the failure to the card that took it", () => {
        const aborted = message([toolCall("c1", "bash", { command: "run" })], {
            stopReason: "aborted",
            errorMessage: "",
        });

        render(<AssistantMessage id="e1" message={aborted} results={new Map()} />);

        // The card of the call the turn never answered carries the failure, and
        // the line under the message would say the same thing a second time.
        expect(screen.getByText("Operation aborted")).toBeInTheDocument();
        expect(screen.getByLabelText("Failed")).toBeInTheDocument();
        expect(screen.getAllByText("Operation aborted")).toHaveLength(1);
    });

    it("puts the failure of an errored turn in the call that never answered", () => {
        const errored = message([toolCall("c1", "bash", { command: "run" })], {
            stopReason: "error",
            errorMessage: "the provider refused",
        });

        render(<AssistantMessage id="e1" message={errored} results={new Map()} />);

        expect(screen.getByText("the provider refused")).toBeInTheDocument();
        expect(screen.getByLabelText("Failed")).toBeInTheDocument();
    });

    it("says an error under a message that called nothing", () => {
        const errored = message([text("half an answer")], { stopReason: "error", errorMessage: "" });

        render(<AssistantMessage id="e1" message={errored} results={new Map()} />);

        // An error without words of its own is still an error: pi says which
        // ("Unknown error"), and the line never reads `Error: Error`.
        expect(screen.getByText("Error: Unknown error")).toBeInTheDocument();
    });

    it("says nothing about a turn that ended well", () => {
        const answered = message([text("all done")]);

        render(<AssistantMessage id="e1" message={answered} results={new Map()} />);

        expect(screen.getByText("all done")).toBeInTheDocument();
        expect(screen.queryByLabelText("Failed")).not.toBeInTheDocument();
    });

    it("draws what a running call streamed, and says that it runs", () => {
        // The message of a call that runs is settled already - the model finished
        // writing it - while the tool is still working: the live state of the run is
        // what says so.
        const settled = message([toolCall("c1", "bash", { command: "cat big.json" })]);
        const call: LiveCall = {
            running: true,
            result: {
                toolCallId: "c1",
                toolName: "bash",
                content: [{ type: "text", text: "half of the file" }],
                isError: false,
                timestamp: 0,
            },
        };

        render(<AssistantMessage id="e1" message={settled} results={new Map()} live={calls(["c1", call])} />);

        expect(screen.getByText("half of the file")).toBeInTheDocument();
        expect(screen.getByLabelText("Running")).toBeInTheDocument();
        expect(screen.queryByLabelText("Waiting")).not.toBeInTheDocument();
        // The result is not an answer yet, so the card shows no check.
        expect(screen.queryByLabelText("Succeeded")).not.toBeInTheDocument();
    });

    it("says nothing of a failure while pi takes the turn up again", () => {
        const failed = message([text("overloaded")], { stopReason: "error", errorMessage: "overloaded" });

        render(
            <AssistantMessage
                id="e1"
                message={failed}
                results={new Map()}
                live={{ calls: new Map(), retrying: true }}
            />,
        );

        expect(screen.queryByText("Error: overloaded")).not.toBeInTheDocument();
    });

    it("draws the thoughts and the words of one answer, in order", () => {
        const thought = message([thinking("first I looked"), text("here it is")]);

        render(<AssistantMessage id="e1" message={thought} results={new Map()} />);

        expect(screen.getByText("Thoughts")).toBeInTheDocument();
        expect(screen.queryByText("first I looked")).not.toBeInTheDocument();
        expect(screen.getByText("here it is")).toBeInTheDocument();
    });

    it("puts the answer of a call in its card", () => {
        const calling = message([toolCall("c1", "bash", { command: "make test" })]);
        const answered = toolResult("c1", "bash", "42 tests passed");

        render(<AssistantMessage id="e1" message={calling} results={results(answered)} />);

        expect(screen.getByText("42 tests passed")).toBeInTheDocument();
        expect(screen.getByLabelText("Succeeded")).toBeInTheDocument();
    });
});
