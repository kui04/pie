import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ComponentType } from "react";
import { ConfirmDialog, DialogAction, DialogFrame, SelectDialog, TextDialog } from "@/components";

/**
 * The shared shapes a question takes: a confirmation, a text field, a choice,
 * and the bare frame a caller can fill. A phone gets the drawer, a desktop the
 * dialog; each story pins the host it reviews.
 */
const meta = {
    title: "Components/Dialogs",
    component: DialogFrame,
    parameters: {
        layout: "fullscreen",
        decorators: [
            (Story: ComponentType) => (
                <div className="flex h-svh items-center justify-center bg-surface font-sans">
                    <p className="text-body-md text-muted-foreground">the workspace behind the scrim</p>
                    <Story />
                </div>
            ),
        ],
    },
    args: {
        open: true,
        onOpenChange: () => undefined,
        isMobile: false,
        title: "A question",
    },
} satisfies Meta<typeof DialogFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

function LiveText() {
    const [value, setValue] = useState("feature/transcript-fold");
    return (
        <TextDialog
            open
            onOpenChange={() => undefined}
            isMobile={false}
            title="Name this branch"
            description="The name the host lists for this branch."
            label="Name"
            value={value}
            onValueChange={setValue}
            fieldId="story-text-dialog"
            submitLabel="Send"
            onSubmit={() => undefined}
        />
    );
}

function LiveSelect() {
    const [answer, setAnswer] = useState<string | null>(null);
    if (answer !== null) {
        return <p className="text-body-md text-foreground">Selected: {answer}</p>;
    }
    return (
        <SelectDialog
            open
            onOpenChange={() => undefined}
            isMobile={false}
            title="Pick a branch"
            options={["main", "feature/transcript-fold", "fix/scroll-bars"]}
            onConfirm={setAnswer}
        />
    );
}

/** Two answers, one of them carrying the consequence. */
export const Confirm: Story = {
    render: (args) => (
        <ConfirmDialog
            {...args}
            title="Delete this conversation?"
            description="The messages leave this machine. A conversation forked from this one keeps its own copy."
            confirmLabel="Delete"
            confirmVariant="destructive"
            onConfirm={() => undefined}
        />
    ),
};

/** The Composer's textarea, inside the shared frame. */
export const Text: Story = {
    render: () => <LiveText />,
};

/** A choice: the rows select, the Confirm key answers. */
export const Select: Story = {
    render: () => <LiveSelect />,
};

/** The drawer shape a phone gets, with its footer keys. */
export const Phone: Story = {
    args: { isMobile: true, title: "A question" },
    render: (args) => (
        <DialogFrame
            {...args}
            description="The drawer is the same frame as the dialog, with the thumb's own spacing."
            actions={
                <>
                    <DialogAction variant="outline" onClick={() => undefined}>
                        Cancel
                    </DialogAction>
                    <DialogAction onClick={() => undefined}>Continue</DialogAction>
                </>
            }
        >
            <p className="text-body-md text-muted-foreground">The body stands here.</p>
        </DialogFrame>
    ),
};

/** The bare frame: a caller keeps its own body and keys. */
export const Frame: Story = {
    args: { title: "A custom question" },
    render: (args) => (
        <DialogFrame
            {...args}
            actions={
                <DialogAction variant="outline" onClick={() => undefined}>
                    Close
                </DialogAction>
            }
        >
            <p className="text-body-md text-muted-foreground">Anything the caller needs goes here.</p>
        </DialogFrame>
    ),
};
