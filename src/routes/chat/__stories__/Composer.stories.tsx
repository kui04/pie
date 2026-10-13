import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createActor } from "xstate";
import { sessionMachine } from "@/machines/session.machine";
import { queryDefaults } from "@/lib/query";
import { Composer } from "@/routes/chat/composer/Composer";
import { sessionState, slashCommand } from "@/preview/fixtures";

/**
 * The box reads the state and the commands of its session over the bridge, which no
 * story can call. The cache is seeded with those answers instead: that is what a
 * read leaves behind, and the box then draws them without asking anyone.
 */
function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "state"], sessionState());
        client.setQueryData(["session", "main:1", "commands"], {
            commands: [
                slashCommand("review", "Review the working tree", "extension"),
                slashCommand("fix-test", "Fix a failing test", "prompt"),
                slashCommand("deploy", "Deploy the app", "skill"),
            ],
        });
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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
    title: "Chat/Composer",
    component: Composer,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <Seeded>
                {/* The box covers the foot of the transcript in the app; the story
                    pins it to the same place, on the same content column, with the
                    band's own air around it. */}
                <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[64rem] px-4 py-2 font-sans">
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

/** Nothing runs: the key sends the message. */
export const Idle: Story = {};

/** An answer streams: the key stops the run, and Enter steers it. */
export const Working: Story = { args: { working: true } };
