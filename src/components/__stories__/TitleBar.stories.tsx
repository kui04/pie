import type { Meta, StoryObj } from "@storybook/react-vite";
import { TitleBar } from "@/components/TitleBar";

/** The bar at the top edge of the app window, with no workspace under it. */

const meta = {
    title: "Chrome/TitleBar",
    component: TitleBar,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story: React.ComponentType) => (
            <div className="bg-surface flex h-svh w-full flex-col font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof TitleBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At rest: the three keys, and nothing else on the row. */
export const Resting: Story = {};

/** With the app's mark in the end that owns branding. */
export const WithMark: Story = { args: { mark: "/tauri.svg" } };
