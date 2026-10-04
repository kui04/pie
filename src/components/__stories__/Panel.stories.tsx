import type { Meta, StoryObj } from "@storybook/react-vite";
import { Panel } from "@/components/Panel";

/** Both cases side by side: the chrome is the only thing telling them apart. */

const meta = {
    title: "Layout/Panel",
    component: Panel,
    // The window is the frame, so these fill it rather than a padded box.
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story: React.ComponentType) => (
            <div className="bg-background flex h-svh w-full font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One panel on a phone: no title bar, so it fills the window. */
export const Solo: Story = {
    args: {
        solo: true,
        children: (
            <p className="text-body-md text-muted-foreground m-auto">
                The whole window, so no margin, no border, no radius.
            </p>
        ),
    },
};

/** One panel on a desktop: the title bar is a panel too, so this one is a card. */
export const Desktop: Story = {
    args: {
        children: (
            <p className="text-body-md text-muted-foreground m-auto">
                A title bar sits above this, so the pane is separated from the window.
            </p>
        ),
    },
};

/** Two panels: the hairline between them is the whole reason it is there. */
export const SideBySide: Story = {
    render: (args) => (
        <>
            <Panel {...args} id="catalogue">
                <p className="text-body-md text-muted-foreground m-auto">catalogue</p>
            </Panel>
            <Panel {...args} id="session">
                <p className="text-body-md text-muted-foreground m-auto">session</p>
            </Panel>
        </>
    ),
};
