import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionEntry } from "@/lib/rpc-protocol";
import { transcriptRows } from "@/lib/transcript";
import { compactedTranscript, longTurnTranscript, sampleTranscript, storeOf } from "@/preview/fixtures";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

/**
 * The transcript of a session: the whole of one, and one after a compaction.
 *
 * These draw what a session holds. The window of a phone and the window of a
 * desktop are the same list; the width of the frame is the layout's business.
 */

const rows = (entries: SessionEntry[]) => {
    const store = storeOf(entries);
    return transcriptRows(store, store.order.length > 0 ? store.order[store.order.length - 1] : null);
};

const meta = {
    title: "Transcript/SessionTranscript",
    component: SessionTranscript,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story: React.ComponentType) => (
            <div className="flex h-svh w-full flex-col bg-surface font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof SessionTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A session of a few turns: a thought, a diff, a long output, a failure. */
export const Session: Story = {
    args: { rows: rows(sampleTranscript()) },
};

/** The same session after a compaction: the summary stands for the older turns. */
export const Compacted: Story = {
    args: { rows: rows(compactedTranscript()) },
};

/** A session nobody has spoken in yet. */
export const Empty: Story = {
    args: { rows: [] },
};

/** A reader has sent words: the app waits for the model's first output, and the region is busy. */
export const Waiting: Story = {
    args: { rows: [{ kind: "activity", id: "activity", state: "waiting" }], working: true },
};

/** The same run once the model writes, or once a call of it runs: still busy. */
export const Working: Story = {
    args: {
        rows: [...rows(sampleTranscript()), { kind: "activity", id: "activity", state: "working" }],
        working: true,
    },
};

/** A long turn: eight calls, a diff, a test run, and a turn that only thought. */
export const LongTurn: Story = {
    args: { rows: rows(longTurnTranscript()) },
};
