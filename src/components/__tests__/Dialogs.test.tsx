import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, DialogAction, DialogFrame, SelectDialog, TextDialog } from "@/components";

afterEach(cleanup);

function TextHarness({
    onSubmit,
    disabled = false,
    initial = "",
}: {
    onSubmit: () => void;
    disabled?: boolean;
    initial?: string;
}) {
    const [value, setValue] = useState(initial);
    return (
        <TextDialog
            open
            onOpenChange={() => undefined}
            isMobile={false}
            title="Name this branch"
            value={value}
            onValueChange={setValue}
            fieldId="text-dialog-field"
            submitLabel="Send"
            submitDisabled={disabled}
            onSubmit={onSubmit}
        />
    );
}

describe("DialogFrame", () => {
    it("draws a dialog on a desktop and a drawer on a phone", () => {
        const { unmount } = render(
            <DialogFrame open onOpenChange={() => undefined} isMobile={false} title="Question">
                body
            </DialogFrame>,
        );
        expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
        expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull();
        unmount();

        render(
            <DialogFrame open onOpenChange={() => undefined} isMobile title="Question">
                body
            </DialogFrame>,
        );
        expect(document.querySelector('[data-slot="drawer-popup"]')).not.toBeNull();
        expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    });

    it("renders a description only when one is given", () => {
        const { unmount } = render(
            <DialogFrame open onOpenChange={() => undefined} isMobile={false} title="Question">
                body
            </DialogFrame>,
        );
        expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
        unmount();

        render(
            <DialogFrame open onOpenChange={() => undefined} isMobile={false} title="Question" description="Detail">
                body
            </DialogFrame>,
        );
        expect(screen.getByRole("dialog")).toHaveAttribute("aria-describedby");
        expect(screen.getByText("Detail")).toBeInTheDocument();
    });

    it("puts the same footer action in each host's shape", () => {
        const { unmount } = render(
            <DialogFrame
                open
                onOpenChange={() => undefined}
                isMobile={false}
                title="Question"
                actions={<DialogAction>Go</DialogAction>}
            />,
        );
        expect(screen.getByRole("button", { name: "Go" })).toHaveClass("rounded-lg", "px-4", "py-3");
        unmount();

        render(
            <DialogFrame
                open
                onOpenChange={() => undefined}
                isMobile
                title="Question"
                actions={<DialogAction>Go</DialogAction>}
            />,
        );
        expect(screen.getByRole("button", { name: "Go" })).toHaveClass("h-10", "flex-1");
    });

    it("closes from its own key", async () => {
        const onOpenChange = vi.fn();
        const user = userEvent.setup();
        render(
            <DialogFrame open onOpenChange={onOpenChange} isMobile={false} title="Question" showClose>
                body
            </DialogFrame>,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});

describe("ConfirmDialog", () => {
    it("reports the two answers", async () => {
        const onConfirm = vi.fn();
        const onOpenChange = vi.fn();
        const user = userEvent.setup();
        render(
            <ConfirmDialog
                open
                onOpenChange={onOpenChange}
                isMobile={false}
                title="Delete this?"
                description="It cannot be undone."
                confirmLabel="Delete"
                confirmVariant="destructive"
                onConfirm={onConfirm}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(onConfirm).toHaveBeenCalledOnce();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("disables the answer while the work is pending", () => {
        render(
            <ConfirmDialog
                open
                onOpenChange={() => undefined}
                isMobile={false}
                title="Delete this?"
                confirmLabel="Delete"
                confirmDisabled
                onConfirm={() => undefined}
            />,
        );
        expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    });
});

describe("TextDialog", () => {
    it("starts with one row, grows to five, and keeps the field's edge", () => {
        render(<TextHarness onSubmit={() => undefined} />);

        const field = screen.getByRole("textbox");
        expect(field.tagName).toBe("TEXTAREA");
        expect(field).toHaveAttribute("rows", "1");
        expect(field).toHaveClass(
            "field-sizing-content",
            "max-h-32.5",
            "min-h-8.5",
            "resize-none",
            "rounded-lg",
            "border",
            "border-input",
            "px-3",
            "focus-visible:ring-0",
        );
    });

    it("puts the caret at the end of the text when it opens", async () => {
        render(<TextHarness onSubmit={() => undefined} initial="feature/x" />);
        const field = screen.getByRole("textbox");

        await waitFor(() => {
            expect(field).toHaveFocus();
            expect(field).toHaveProperty("selectionStart", 9);
            expect(field).toHaveProperty("selectionEnd", 9);
        });
    });

    it("submits on Enter and leaves Shift+Enter for the newline", () => {
        const onSubmit = vi.fn();
        render(<TextHarness onSubmit={onSubmit} />);
        const field = screen.getByRole("textbox");

        fireEvent.keyDown(field, { key: "Enter" });
        expect(onSubmit).toHaveBeenCalledOnce();

        onSubmit.mockClear();
        fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not submit while an IME is composing", () => {
        const onSubmit = vi.fn();
        render(<TextHarness onSubmit={onSubmit} />);

        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });

        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not submit while its action is disabled", () => {
        const onSubmit = vi.fn();
        render(<TextHarness onSubmit={onSubmit} disabled />);

        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });
});

describe("SelectDialog", () => {
    it("selects with a click and answers only on Confirm", async () => {
        const onConfirm = vi.fn();
        const user = userEvent.setup();
        render(
            <SelectDialog
                open
                onOpenChange={() => undefined}
                isMobile={false}
                title="Pick a branch"
                options={["main", "feature/x"]}
                onConfirm={onConfirm}
            />,
        );

        const options = screen.getAllByRole("option");
        expect(options[0]).toHaveAttribute("aria-selected", "true");

        await user.click(screen.getByRole("option", { name: "feature/x" }));
        expect(screen.getByRole("option", { name: "feature/x" })).toHaveAttribute("aria-selected", "true");
        expect(onConfirm).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Confirm" }));
        expect(onConfirm).toHaveBeenCalledWith("feature/x");
    });

    it("moves the selection with the arrow keys, not the pointer", () => {
        render(
            <SelectDialog
                open
                onOpenChange={() => undefined}
                isMobile={false}
                title="Pick a branch"
                options={["main", "feature/x"]}
                onConfirm={() => undefined}
            />,
        );
        const list = screen.getByRole("listbox", { name: "Pick a branch" });
        const options = screen.getAllByRole("option");

        fireEvent.mouseMove(options[1]);
        expect(options[0]).toHaveAttribute("aria-selected", "true");

        fireEvent.keyDown(list, { key: "ArrowDown" });
        expect(screen.getByRole("option", { name: "feature/x" })).toHaveAttribute("aria-selected", "true");
    });

    it("answers the selected row with Enter", () => {
        const onConfirm = vi.fn();
        render(
            <SelectDialog
                open
                onOpenChange={() => undefined}
                isMobile={false}
                title="Pick a branch"
                options={["main", "feature/x"]}
                onConfirm={onConfirm}
            />,
        );
        const list = screen.getByRole("listbox", { name: "Pick a branch" });

        fireEvent.keyDown(list, { key: "ArrowDown" });
        fireEvent.keyDown(list, { key: "Enter" });

        expect(onConfirm).toHaveBeenCalledWith("feature/x");
    });

    it("offers no answer for an empty list", () => {
        render(
            <SelectDialog
                open
                onOpenChange={() => undefined}
                isMobile={false}
                title="Pick a branch"
                options={[]}
                onConfirm={() => undefined}
            />,
        );

        expect(screen.getByText("No options.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    });
});
