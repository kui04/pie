import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createActor } from "xstate";
import { queryDefaults } from "@/lib/query";
import type { Event as SessionRecord } from "@/lib/rpc-protocol";
import { sessionMachine } from "@/machines/session.machine";
import type { SessionRef } from "@/lib/sessions";
import { SessionMenu } from "@/routes/chat/menu/SessionMenu";
import { sessionState } from "@/preview/fixtures";

/**
 * The menu of one conversation, opened as a press opens it. Its commands are the ones
 * no story can call: what the story shows is the menu itself, and the session it acts
 * on is a chart with stubbed listeners.
 */
const SESSION = "main:1";

function idle(): SessionRef {
    return createActor(sessionMachine, {
        input: {
            listen: () => new Promise<never>(() => undefined),
            reRead: () => undefined,
            notice: () => undefined,
        },
    }).start();
}

/** The same chart, after a run began: the phase the two rows of fork and copy wait for. */
function running(): SessionRef {
    const machine = idle();
    machine.send({ type: "RECORD", at: 1, record: { type: "agent_start" } as SessionRecord });
    return machine;
}

function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        // The state the bar reads: the menu takes the name and the file from the same
        // cache, so the seed is what its rows act on.
        client.setQueryData(["session", SESSION, "state"], sessionState());
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
    title: "Chat/SessionMenu",
    component: SessionMenu,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <Seeded>
                <div className="flex justify-end p-4">
                    <Story />
                </div>
            </Seeded>
        ),
    ],
    args: {
        session: SESSION,
        machine: idle(),
        endpoint: "local",
        open: true,
        onOpenChange: () => undefined,
        onClose: () => undefined,
        onGone: () => undefined,
        isMobile: false,
    },
} satisfies Meta<typeof SessionMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A conversation at rest: every row is at hand, and the file is known. */
export const Idle: Story = {};

/**
 * A run streams: pi would abort it to fork or copy, so those two rows wait. The name,
 * the file and the process stay in reach.
 */
export const Working: Story = {
    args: { machine: running() },
};
