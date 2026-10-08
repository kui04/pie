import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommandMenu } from "@/routes/chat/components/composer/CommandMenu";
import { commandRows } from "@/routes/chat/components/composer/slash";
import { slashCommand } from "@/preview/fixtures";

const commands = [
    slashCommand("review", "Review the working tree", "extension"),
    slashCommand("fix-test", "Fix a failing test", "prompt"),
    slashCommand("deploy", "Deploy the app", "skill"),
];

const meta = {
    title: "Chat/CommandMenu",
    component: CommandMenu,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            // The panel floats above the message box; the story pins it where it lands.
            <div className="fixed inset-x-0 bottom-40 px-3 font-sans">
                <Story />
            </div>
        ),
    ],
    args: {
        id: "composer-command-menu",
        rows: commandRows("", commands, false),
        highlighted: "pie-compact",
        onHighlight: () => undefined,
        onChoose: () => undefined,
    },
} satisfies Meta<typeof CommandMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every row, with the commands of pie above the ones pi registered. */
export const Commands: Story = {};

/** What `/comp` leaves: the two commands of pie whose names start with it. */
export const Filtered: Story = { args: { rows: commandRows("comp", commands, true), highlighted: "pie-compact" } };

/**
 * A host that registered more commands than fit: the list scrolls, and it opens on the
 * row the keyboard is on rather than at the top.
 */
export const ManyRows: Story = {
    args: {
        rows: Array.from({ length: 30 }, (_, index) => ({
            id: `row-${index}`,
            label: `/row-${index}`,
            description: "A command of a host that registered many",
            action: { kind: "complete" as const, name: `row-${index}` },
        })),
        highlighted: "row-24",
    },
};
