import type { Meta, StoryObj } from "@storybook/react-vite";
import { RenameSession } from "@/routes/chat/menu/RenameSession";

const meta = {
    title: "Chat/RenameSession",
    component: RenameSession,
    parameters: { layout: "fullscreen" },
    args: {
        session: "main:1",
        open: true,
        onOpenChange: () => undefined,
        initial: "Fix the parser",
        onRenamed: () => undefined,
        isMobile: false,
    },
} satisfies Meta<typeof RenameSession>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A conversation pi already named: the field opens with that name. */
export const Named: Story = {};

/** A conversation with no name yet: the field opens empty, and one is required. */
export const Unnamed: Story = {
    args: { initial: null },
};

/** The same question as the sheet a thumb can reach. */
export const Phone: Story = {
    args: { isMobile: true },
};
