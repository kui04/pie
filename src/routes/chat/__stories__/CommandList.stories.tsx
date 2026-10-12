import type { Meta, StoryObj } from "@storybook/react-vite";
import { Popover, PopoverAnchor } from "@/components/ui";
import { CommandList } from "@/routes/chat/composer/CommandList";
import { commandRows } from "@/routes/chat/composer/command";
import { slashCommand } from "@/preview/fixtures";

const commands = [
    slashCommand("review", "Review the working tree", "extension"),
    slashCommand("release", "Prepare a release", "prompt"),
    slashCommand("fix-test", "Fix a failing test", "prompt"),
    slashCommand("deploy", "Deploy the app", "skill"),
];

const meta = {
    title: "Chat/CommandList",
    component: CommandList,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            // The panel is a popover content, so the story stands its root and a box
            // for its anchor, where the message box would be in the app.
            <div className="fixed inset-x-0 bottom-40 px-3 font-sans">
                <Popover open>
                    <PopoverAnchor asChild>
                        <span className="text-body-md text-muted-foreground">The message box stands here.</span>
                    </PopoverAnchor>
                    <Story />
                </Popover>
            </div>
        ),
    ],
    args: {
        id: "composer-command-menu",
        rows: commandRows("", commands),
        highlighted: "pi-review",
        onHighlight: () => undefined,
        onChoose: () => undefined,
    },
} satisfies Meta<typeof CommandList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every row: the commands pi registered, each with what it says about itself. */
export const Commands: Story = {};

/** What `/re` leaves: the commands whose names start with it. */
export const Filtered: Story = { args: { rows: commandRows("re", commands), highlighted: "pi-review" } };

/**
 * A host that registered more commands than fit: the list scrolls, and it opens on the
 * row the keyboard is on rather than at the top.
 */
export const ManyRows: Story = {
    args: {
        rows: Array.from({ length: 30 }, (_, index) => ({
            id: `row-${index}`,
            name: `row-${index}`,
            description: "A command of a host that registered many",
        })),
        highlighted: "row-24",
    },
};
