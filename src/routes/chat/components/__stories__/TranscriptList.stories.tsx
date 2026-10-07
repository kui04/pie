import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionEntry } from "@/lib/protocol";
import { transcriptRows } from "@/lib/transcript";
import { compactedTranscript, sampleTranscript, storeOf } from "@/preview/fixtures";
import { TranscriptList } from "@/routes/chat/components/TranscriptList";

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
    title: "Transcript/TranscriptList",
    component: TranscriptList,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story: React.ComponentType) => (
            <div className="bg-surface flex h-svh w-full flex-col font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof TranscriptList>;

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
