import type { Meta, StoryObj } from "@storybook/react-vite";
import { DeleteSession } from "@/routes/chat/menu/DeleteSession";

const meta = {
    title: "Chat/DeleteSession",
    component: DeleteSession,
    parameters: { layout: "fullscreen" },
    args: {
        session: "main:1",
        file: "/home/kui/.pi/agent/sessions/pie/2026-01-01T00-00-00-000Z_0193f0c4.jsonl",
        open: true,
        onOpenChange: () => undefined,
        onDeleted: () => undefined,
        isMobile: false,
    },
} satisfies Meta<typeof DeleteSession>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The one confirmation before the process ends and the file goes. */
export const Confirm: Story = {};

/** The same confirmation as the sheet a thumb can reach. */
export const Phone: Story = {
    args: { isMobile: true },
};
