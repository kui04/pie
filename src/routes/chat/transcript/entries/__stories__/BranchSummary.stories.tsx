import type { Meta, StoryObj } from "@storybook/react-vite";
import { BranchSummary } from "@/routes/chat/transcript/entries/BranchSummary";

/** The summary of a branch the session left, read like a compaction. */

const meta = {
    title: "Transcript/BranchSummary",
    component: BranchSummary,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof BranchSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A branch summary: the word on its row, the whole summary behind it. */
export const Summary: Story = {
    args: {
        id: "story-branch",
        quote: true,
        body: ["The other branch tried a regex for the split,", "and fell back to filtering empty lines."].join("\n"),
    },
};
