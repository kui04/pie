import type { Meta, StoryObj } from "@storybook/react-vite";
import { CustomMessage } from "@/routes/chat/transcript/entries/CustomMessage";

/** A custom message of an extension, under the word its extension gave it. */

const meta = {
    title: "Transcript/CustomMessage",
    component: CustomMessage,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof CustomMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A custom message: one line in the header, the whole message behind it. */
export const Message: Story = {
    args: {
        id: "story-custom",
        quote: true,
        label: "Review",
        summary: "Two files still miss coverage.",
        body: ["Two files still miss coverage.", "", "Add tests for the parser's empty input."].join("\n"),
    },
};

/** A custom message of one line has nothing behind it, so it is not a button. */
export const OneLine: Story = {
    args: {
        id: "story-custom-oneline",
        label: "Review",
        summary: "Two files still miss coverage.",
        body: null,
    },
};
