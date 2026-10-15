import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skill } from "@/routes/chat/transcript/entries/Skill";

/** What a skill run left behind: the word, one line, and the whole of it. */

const meta = {
    title: "Transcript/Skill",
    component: Skill,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Skill>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A skill: one line in the header, the whole report behind it. */
export const Report: Story = {
    args: {
        id: "story-skill",
        quote: true,
        summary: "The skill `release-notes` ran.",
        body: ["The skill `release-notes` ran.", "", "It wrote three entries into `CHANGELOG.md`."].join("\n"),
    },
};

/** A skill of one line has nothing behind it, so it is not a button. */
export const OneLine: Story = {
    args: {
        id: "story-skill-oneline",
        summary: "The skill `release-notes` ran.",
        body: null,
    },
};
