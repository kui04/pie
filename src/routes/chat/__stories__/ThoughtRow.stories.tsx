import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThoughtRow } from "@/routes/chat/transcript/entries/ThoughtRow";

/**
 * What the model reasoned, as one row of its own.
 *
 * A thought is an entry of the session, so it is a row and never a count. While it arrives the
 * word shimmers and the body is read through a window that keeps its newest line in view; when
 * the model stops thinking it folds itself to the row.
 */
const meta = {
    title: "Transcript/ThoughtRow",
    component: ThoughtRow,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="bg-surface w-full max-w-3xl p-6 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof ThoughtRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const reasoning =
    "The parser trims each line before the filter runs, so a blank line arrives empty. A file that ends with a newline yields one more empty line, which the same filter drops.";

/** A thought that is still arriving: open, shimmering, and closed at its end. */
export const Streaming: Story = {
    args: { id: "t1", thinking: reasoning, stillThinking: true },
};

/** A thought that is written: a line a reader may open. */
export const Settled: Story = {
    args: { id: "t2", thinking: reasoning },
};
