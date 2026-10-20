import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExtensionSnapshot } from "@/lib/bridge";
import { queryDefaults, sessionKeys } from "@/lib/query";
import { SessionExtensions } from "@/routes/chat/topbar/SessionExtensions";

const SESSION = "main:1";
const statuses = [
    { key: "pi-permission-system", text: "yolo" },
    { key: "ollama-usage", text: "Request in flight" },
];

function snapshot(): ExtensionSnapshot {
    return { requests: [], statuses, title: null, editorText: null };
}

function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(sessionKeys.extension(SESSION), snapshot());
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The bar's extension key: the dot says a status exists, and a press opens the
 * list. The statuses are seeded where the dialog reads them.
 */
const meta = {
    title: "Chat/Extension status",
    component: SessionExtensions,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <Seeded>
                <div className="flex justify-end bg-surface p-4 font-sans">
                    <Story />
                </div>
            </Seeded>
        ),
    ],
    args: { session: SESSION },
} satisfies Meta<typeof SessionExtensions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A session with two status lines: the dot is on, and the dialog has their words. */
export const Reported: Story = {};
