import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectionLostOverlay } from "@/routes/connect/ConnectionLostOverlay";

/**
 * The one surface of a lost link, over a page that is still there. The window behind it is
 * this story's own: the overlay is a dialog in a portal, so the plane it blurs is whatever is
 * on screen.
 */
const meta = {
    title: "Connect/ConnectionLostOverlay",
    component: ConnectionLostOverlay,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <div className="fixed inset-0 flex flex-col bg-surface font-sans text-foreground">
                {/* Something like the page it stands over: the overlay must read as a veil on
                    a window that is still there, and a flat plane would not show that. */}
                <div className="flex min-h-11 items-center gap-2 px-3">
                    <div className="size-6 rounded-md bg-card" />
                    <div className="h-3 w-40 rounded-full bg-muted" />
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
                    <p className="text-body-sm text-muted-foreground">
                        The parser is rewritten and the tests are green. Next I will look at the transcript’s own
                        markdown, because a table in a comment arrives as a wall of pipes, and a fenced block has no
                        colour of its own yet.
                    </p>
                    <p className="text-body-sm text-muted-foreground">
                        There is one thing I am unsure about: whether the session should keep running while the window
                        is closed, or whether the reach ends with the link. The process is cheap on the host, and a run
                        that keeps going is what a phone expects.
                    </p>
                    <div className="h-20 rounded-lg bg-card" />
                    <div className="h-12 rounded-lg bg-card" />
                </div>
                <Story />
            </div>
        ),
    ],
    args: {
        endpoint: "kui04@localhost:22",
        message: null,
        onRetry: () => undefined,
        onLeave: () => undefined,
    },
} satisfies Meta<typeof ConnectionLostOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The moment the link goes: nothing has been tried yet. */
export const Lost: Story = { args: { state: "lost" } };

/** A dial is under way. The button says so and takes no second press. */
export const Retrying: Story = { args: { state: "retrying" } };

/** A dial failed. The sentence is the one Rust wrote, and the offer stands. */
export const Failed: Story = {
    args: { state: "failed", message: "The host would not answer: connection refused (os error 111)." },
};
