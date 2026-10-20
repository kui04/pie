import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryDefaults } from "@/lib/query";
import { ForkSession } from "@/routes/chat/SessionMenu";

/**
 * The fork points come from pi (`get_fork_messages`), which no story can call: each
 * story seeds the cache with the answer instead.
 */
const POINTS = [
    { entryId: "e1", text: "Make the parser skip empty lines." },
    { entryId: "e2", text: "Now run the tests and fix what fails." },
    {
        entryId: "e3",
        text: "Write down why the drawer keeps its state while it is closed, in the comment of the form.",
    },
];

function Seeded({ points, children }: { points: typeof POINTS; children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "forkMessages"], points);
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
    title: "Chat/ForkSession",
    component: ForkSession,
    parameters: { layout: "fullscreen", points: POINTS },
    decorators: [
        (Story, context) => (
            <Seeded points={context.parameters.points as typeof POINTS}>
                <Story />
            </Seeded>
        ),
    ],
    args: {
        session: "main:1",
        onClose: () => undefined,
        onForked: () => undefined,
        isMobile: false,
    },
} satisfies Meta<typeof ForkSession>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The user turns of a conversation, the way pi lists them: every message with text. */
export const Messages: Story = {};

/** The same list as the sheet a thumb can scroll. */
export const Phone: Story = {
    args: { isMobile: true },
};

/** Nothing has been said in this conversation, so there is nothing to fork from. */
export const Empty: Story = {
    parameters: { points: [] },
};
