import type { Meta, StoryObj } from "@storybook/react-vite";
import { Window } from "@/components/Window";
import { SessionHeader } from "@/routes/chat/components/session/SessionHeader";
import { sessionStats } from "@/preview/fixtures";

/**
 * The session's slots of the window's bar, shown in the bar the window draws: the
 * keys to the right are the window's own, not the session's.
 */

const meta = {
    title: "Chat/SessionHeader",
    component: SessionHeader,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <div className="fixed inset-0 flex font-sans">
                <Window topbar={<Story />} />
            </div>
        ),
    ],
    args: {
        name: "Fix the parser",
        cwd: "/home/kui/Projects/pie",
        stats: sessionStats(),
        auto: false,
        onToggleSessions: () => undefined,
    },
} satisfies Meta<typeof SessionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A session with the name its owner gave it, beside the list of sessions. */
export const Named: Story = {};

/** The list out beside the chat: the key carries the fold that a press would do. */
export const Expanded: Story = {
    args: { expanded: true },
};

/** The list folded away: the key carries the open that a press would do, and the name takes the room it left. */
export const Folded: Story = {
    args: { expanded: false },
};

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
