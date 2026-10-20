import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { ExtensionUIRequest } from "@/lib/rpc-protocol";
import { ExtensionPrompt } from "@/routes/chat/transcript/ExtensionPrompt";

const select: ExtensionUIRequest = {
    type: "extension_ui_request",
    id: "story-select",
    method: "select",
    title: "Allow this command?",
    options: ["Allow once", "Allow always", "Block"],
};

const confirm: ExtensionUIRequest = {
    type: "extension_ui_request",
    id: "story-confirm",
    method: "confirm",
    title: "Clear the session?",
    message: "All messages leave the context. The conversation file stays on the host.",
};

const input: ExtensionUIRequest = {
    type: "extension_ui_request",
    id: "story-input",
    method: "input",
    title: "Name this branch",
    placeholder: "feature/transcript-fold",
};

const editor: ExtensionUIRequest = {
    type: "extension_ui_request",
    id: "story-editor",
    method: "editor",
    title: "Review the message",
    prefill: "The parser now keeps the trailing newline.\n\nThis also covers the empty input case.",
};

/**
 * The four dialogs that block an extension. The answer is a no-op here: a story
 * shows the question, not the process that would receive its answer.
 */
function LiveSelect({ props }: { props: Parameters<typeof ExtensionPrompt>[0] }) {
    const [answer, setAnswer] = useState<string | null>(null);
    if (answer !== null) {
        return (
            <div
                className="
                    flex min-h-40 items-center justify-center bg-surface p-6 font-sans text-body-md text-foreground
                "
            >
                Selected: {answer}
            </div>
        );
    }
    return (
        <ExtensionPrompt {...props} onAnswer={(next) => setAnswer(next.type === "value" ? next.value : "cancelled")} />
    );
}

const meta = {
    title: "Chat/Extension prompt",
    component: ExtensionPrompt,
    parameters: { layout: "fullscreen" },
    args: { request: select, onAnswer: () => undefined, isMobile: false },
} satisfies Meta<typeof ExtensionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A choice: the extension is waiting for one value. */
export const Select: Story = {
    render: (args) => <LiveSelect props={args} />,
};

/** A yes-or-no question, with the consequence in the body. */
export const Confirm: Story = { args: { request: confirm } };

/** One line of text. */
export const Input: Story = { args: { request: input } };

/** A multi-line editor with a prefill. */
export const Editor: Story = { args: { request: editor } };

/** The same question on a phone: the dialog becomes a bottom sheet. */
export const Phone: Story = { args: { request: confirm, isMobile: true } };
