import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionPrompt } from "@/routes/chat/transcript/ExtensionPrompt";
import type { ExtensionUIRequest } from "@/lib/rpc-protocol";

function select(): ExtensionUIRequest {
    return {
        type: "extension_ui_request",
        id: "q-select",
        method: "select",
        title: "Allow this command?",
        options: ["Allow once", "Allow always", "Block"],
    };
}

function confirm(id = "q-confirm"): ExtensionUIRequest {
    return {
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: "Clear the session?",
        message: "All messages leave the context.",
    };
}

describe("ExtensionPrompt", () => {
    it("answers a select request with the chosen option", () => {
        const answer = vi.fn();
        render(<ExtensionPrompt request={select()} onAnswer={answer} isMobile={false} />);

        expect(screen.getByText("Allow this command?")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("option", { name: "Allow once" }));
        expect(answer).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        expect(answer).toHaveBeenCalledWith({ type: "value", value: "Allow once" });
    });

    it("moves the lit option with the arrow keys and answers with Enter", () => {
        const answer = vi.fn();
        render(<ExtensionPrompt request={select()} onAnswer={answer} isMobile={false} />);

        const list = screen.getByRole("listbox", { name: "Allow this command?" });
        fireEvent.keyDown(list, { key: "ArrowDown" });
        fireEvent.keyDown(list, { key: "Enter" });
        expect(answer).toHaveBeenCalledWith({ type: "value", value: "Allow always" });
    });

    it("keeps the keyboard light when the pointer moves", () => {
        render(<ExtensionPrompt request={select()} onAnswer={vi.fn()} isMobile={false} />);

        const first = screen.getByRole("option", { name: "Allow once" });
        const second = screen.getByRole("option", { name: "Allow always" });
        fireEvent.mouseMove(second);
        expect(first).toHaveAttribute("data-lit", "true");
        expect(second).toHaveAttribute("data-lit", "false");
    });

    it("answers a confirm request with yes or no", () => {
        const answer = vi.fn();
        const { rerender } = render(<ExtensionPrompt request={confirm()} onAnswer={answer} isMobile={false} />);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(answer).toHaveBeenCalledWith({ type: "cancelled" });

        answer.mockClear();
        rerender(<ExtensionPrompt request={confirm("q-confirm-2")} onAnswer={answer} isMobile={false} />);
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        expect(answer).toHaveBeenCalledWith({ type: "confirmed", confirmed: true });
    });

    it("answers an input request with the typed value", () => {
        const answer = vi.fn();
        render(
            <ExtensionPrompt
                request={{
                    type: "extension_ui_request",
                    id: "q-input",
                    method: "input",
                    title: "Name",
                    placeholder: "Branch name",
                }}
                onAnswer={answer}
                isMobile={false}
            />,
        );

        fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature/x" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        expect(answer).toHaveBeenCalledWith({ type: "value", value: "feature/x" });
    });

    it("answers an editor with the prefilled text and an edit", () => {
        const answer = vi.fn();
        render(
            <ExtensionPrompt
                request={{
                    type: "extension_ui_request",
                    id: "q-editor",
                    method: "editor",
                    title: "Review",
                    prefill: "Line one",
                }}
                onAnswer={answer}
                isMobile={false}
            />,
        );

        const editor = screen.getByRole("textbox");
        expect(editor).toHaveValue("Line one");
        fireEvent.change(editor, { target: { value: "Line two" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(answer).toHaveBeenCalledWith({ type: "value", value: "Line two" });
    });

    it("sends a cancellation when the dialog is closed", () => {
        const answer = vi.fn();
        render(<ExtensionPrompt request={confirm()} onAnswer={answer} isMobile={false} />);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(answer).toHaveBeenCalledWith({ type: "cancelled" });
    });

    it("draws nothing for a fire-and-forget request", () => {
        render(
            <ExtensionPrompt
                request={{ type: "extension_ui_request", id: "n-1", method: "notify", message: "Saved" }}
                onAnswer={vi.fn()}
                isMobile={false}
            />,
        );
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});
