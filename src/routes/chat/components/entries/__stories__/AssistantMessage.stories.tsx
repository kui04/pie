import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AssistantMessage as AssistantMessageData } from "@/lib/protocol";
import { assistant, text, thinking, toolCall, usage } from "@/preview/fixtures";
import { AssistantMessage } from "@/routes/chat/components/entries/AssistantMessage";

/**
 * One answer of the model.
 *
 * A settled turn holds what it said; an unsettled one is a model at work, and
 * says so - the shimmer of the thought, the turning ring of the call, and the
 * line that closes it.
 */

const meta = {
    title: "Transcript/AssistantMessage",
    component: AssistantMessage,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="flex w-full max-w-2xl flex-col p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof AssistantMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

const answer = (stopReason: AssistantMessageData["stopReason"]): AssistantMessageData =>
    assistant(
        [
            thinking("The split leaves empty trailing entries, so filtering after the split is enough."),
            text("Filtering the lines after the split does it."),
            toolCall("c1", "bash", { command: "pnpm test" }),
        ],
        { stopReason, usage: usage() },
    ) as AssistantMessageData;

/** What a turn looks like once it has settled. */
export const Settled: Story = {
    args: { id: "story-settled", message: answer("stop"), results: new Map() },
};

/** The same turn while the model is still writing it. */
export const Working: Story = {
    args: { id: "story-working", message: answer("pending"), results: new Map() },
};
