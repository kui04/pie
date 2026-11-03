import type { Meta, StoryObj } from "@storybook/react-vite";
import { Compaction } from "@/routes/chat/transcript/entries/Compaction";

/** What a compaction left behind: the word alone, the summary behind it. */

const meta = {
    title: "Transcript/Compaction",
    component: Compaction,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Compaction>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A compaction: the word and the size it cut from, the whole summary behind it. */
export const Summary: Story = {
    args: {
        id: "story-compaction",
        tokensBefore: 18432,
        quote: true,
        body: [
            "The parser was changed to filter empty lines after the split, and the tests",
            "for the parser were run and pass.",
            "",
            "The changelog has not been touched yet.",
        ].join("\n"),
    },
};
