import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionHeader } from "@/routes/chat/components/session/SessionHeader";
import { sessionStats } from "@/preview/fixtures";

const meta = {
    title: "Chat/SessionHeader",
    component: SessionHeader,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <div className="w-[360px]">
                <Story />
            </div>
        ),
    ],
    args: {
        id: "session-header",
        name: "Fix the parser",
        cwd: "/home/kui/Projects/pie",
        stats: sessionStats(),
        auto: false,
        onOpenSessions: () => undefined,
    },
} satisfies Meta<typeof SessionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A session with the name its owner gave it, and a context that is barely used. */
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
