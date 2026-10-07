import type { Meta, StoryObj } from "@storybook/react-vite";
import { NoticeCard } from "@/routes/chat/components/entries/NoticeCard";

/** What the transcript says without being a message. */

const meta = {
    title: "Transcript/NoticeCard",
    component: NoticeCard,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof NoticeCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A compaction: one line in the header, the whole summary behind it. */
export const Compaction: Story = {
    args: {
        id: "story-compaction",
        label: "[compaction]",
        summary: "The parser was changed to filter empty lines after the split",
        body: [
            "The parser was changed to filter empty lines after the split, and the tests",
            "for the parser were run and pass.",
            "",
            "The changelog has not been touched yet.",
        ].join("\n"),
    },
};

/** A notice of one line has nothing behind it, so it is not a button. */
export const OneLine: Story = {
    args: {
        id: "story-notice",
        label: "[skill]",
        summary: "The skill `release-notes` ran.",
        body: null,
    },
};
