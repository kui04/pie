import type { Meta, StoryObj } from "@storybook/react-vite";
import { SafeArea, WindowControls } from "@/components";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";

/**
 * The session's slots of the window's bar, shown in the bar the window draws: the
 * keys to the right are the window's own, not the session's.
 */

const meta = {
    title: "Chat/SessionTopbar",
    component: SessionTopbar,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <div className="fixed inset-0 flex bg-surface font-sans">
                {/* The page of the screen the bar is drawn in: the system bars' room is
                    the page's own, and the bar is its first row. */}
                <SafeArea side="all" id="safe-main" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div
                        id="topbar"
                        data-tauri-drag-region="deep"
                        className="flex min-h-11 shrink-0 items-center gap-1 px-3"
                    >
                        <SidebarToggle onToggleSessions={() => undefined} />
                        <Story />
                        <WindowControls />
                    </div>
                </SafeArea>
            </div>
        ),
    ],
    args: {
        name: "Fix the parser",
        cwd: "/home/kui/Projects/pie",
    },
} satisfies Meta<typeof SessionTopbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A session with the name its owner gave it, beside the list of sessions. */
export const Named: Story = {};

/** A session pi holds no name for: the bar falls back to its directory. */
export const Unnamed: Story = {
    args: { name: null },
};

/** A session with a name long enough that the bar has to cut it. */
export const LongName: Story = {
    args: { name: "Rework the transcript folding for the fork leaf path and the compaction" },
};

/** A session pi holds no name for: the bar takes the words that opened it. */
export const FirstMessage: Story = {
    args: { name: null, firstMessage: "Read package.json and run git status" },
};
