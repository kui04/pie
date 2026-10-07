import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThinkingCard } from "@/routes/chat/components/entries/ThinkingCard";

/** What the model thought, closed until a reader asks for it. */

const meta = {
    title: "Transcript/ThinkingCard",
    component: ThinkingCard,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof ThinkingCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const THOUGHT =
    "The split leaves empty trailing entries, so filtering after the split is enough. The tests then cover the empty line itself, which the old code dropped before it ever reached them.";

/** A finished thought: the label says so, and the reasoning waits behind it. */
export const Closed: Story = {
    args: {
        id: "story-thinking",
        thinking: THOUGHT,
    },
};

/** The same card while the model is still thinking: the label shimmers. */
export const Thinking: Story = {
    args: {
        id: "story-thinking-live",
        thinking: THOUGHT,
        stillThinking: true,
    },
};
