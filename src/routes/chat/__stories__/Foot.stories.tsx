import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createActor } from "xstate";
import { sessionMachine } from "@/machines/session.machine";
import { queryDefaults } from "@/lib/query";
import { transcriptRows } from "@/lib/transcript";
import { sampleTranscript, sessionState, slashCommand, storeOf } from "@/preview/fixtures";
import { Composer } from "@/routes/chat/composer/Composer";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

/**
 * The foot of a conversation: the list of what was said, and the box under it.
 *
 * The seam between the two is a geometry of its own — the list's content and the
 * box stand on one line, and the 8px the list ends its content on is the 8px of
 * the box's corner — and it exists only where the two meet, which no other story
 * draws.
 *
 * The box reads the state and the commands of its session over the bridge, which
 * no story can call. The cache is seeded with those answers instead, which is what
 * a read leaves behind.
 */
function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "state"], sessionState());
        client.setQueryData(["session", "main:1", "commands"], {
            commands: [slashCommand("review", "Review the working tree", "extension")],
        });
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const store = storeOf(sampleTranscript());
const rows = transcriptRows(store, store.order.length > 0 ? store.order[store.order.length - 1] : null);

/**
 * The chart of the story's session: no listeners, no reads - the box reads its card from
 * the context, and the seeded cache answers everything else.
 */
const machine = createActor(sessionMachine, {
    input: {
        listen: () => new Promise<never>(() => undefined),
        reRead: () => undefined,
        notice: () => undefined,
    },
}).start();

const meta = {
    title: "Chat/Foot",
    component: Composer,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <Seeded>
                {/* The window's frame, as the app builds it: the shell clips, the chat
                    is one column, and the composer's band stands at its foot. */}
                <div className="bg-surface flex h-svh w-full flex-col font-sans">
                    <Story />
                </div>
            </Seeded>
        ),
    ],
    args: {
        session: "main:1",
        working: false,
        machine,
    },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A session of a few turns, with the box the reader writes their answer in. */
export const Session: Story = {
    render: (args) => (
        <>
            <SessionTranscript rows={rows} />
            <div id="composer-band" className="my-2 mt-auto flex shrink-0 items-center justify-center">
                <div className="mx-auto w-full max-w-5xl px-4">
                    <Composer {...args} />
                </div>
            </div>
        </>
    ),
};
