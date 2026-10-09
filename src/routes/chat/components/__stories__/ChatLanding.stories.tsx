import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatLanding } from "@/routes/chat/components/ChatLanding";
import { SidebarToggle } from "@/routes/chat/components/session/SidebarToggle";
import { Window } from "@/components/Window";

/**
 * The landing of the chat: the words of pi and the keys of the window.
 *
 * The keys are the window's own plan and their bindings are not made yet (see
 * `docs/TODO.md`), so a press on one does nothing here either.
 */
const meta = {
    title: "Chat/ChatLanding",
    component: ChatLanding,
    render: (args) => (
        // The window itself, so the story shows the bar the landing is drawn under:
        // the way to the list, and the window's own keys.
        <div className="fixed inset-0 flex font-sans">
            <Window topbar={<SidebarToggle onToggleSessions={() => undefined} />}>
                <ChatLanding {...args} />
            </Window>
        </div>
    ),
} satisfies Meta<typeof ChatLanding>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The window of a host that holds sessions: the list is one press away. */
export const Landing: Story = {
    args: { disconnected: false },
};

/** A window with no connection at all: the gate is the only way out of it. */
export const Disconnected: Story = {
    args: { disconnected: true },
};
