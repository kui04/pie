import type { Meta, StoryObj } from "@storybook/react-vite";
import { SafeArea, WindowControls } from "@/components";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";
import { sessionStats } from "@/preview/fixtures";

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
        stats: sessionStats(),
        auto: false,
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

/** Past 70 of the context window the ring turns to pi's warning colour. */
export const Warning: Story = {
    args: { stats: sessionStats({ contextUsage: { tokens: 420000, contextWindow: 512000, percent: 82.3 } }) },
};

/** Past 90 it alarms. */
export const Alarmed: Story = {
    args: { stats: sessionStats({ contextUsage: { tokens: 500000, contextWindow: 512000, percent: 97.7 } }) },
};

/** Right after a compaction pi does not know the context yet: the ring shows no arc. */
export const UnknownUsage: Story = {
    args: { stats: sessionStats({ contextUsage: { tokens: null, contextWindow: 512000, percent: null } }) },
};

/** A session that has spent nothing yet: the popover leaves those lines out. */
export const Fresh: Story = {
    args: { stats: sessionStats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }) },
};

/** With automatic compaction on, the reading says so, as pi's footer does. */
export const AutoCompaction: Story = {
    args: { auto: true },
};

/** Before the first read answers, the ring has no reading behind it at all. */
export const BeforeTheFirstRead: Story = {
    args: { stats: null },
};
