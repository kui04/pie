import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionSummary } from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { ChatFrame } from "@/routes/chat/ChatFrame";
import { ChatTopbar } from "@/routes/chat/ChatTopbar";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";
import { SessionLanding } from "@/routes/chat/SessionLanding";
import { SessionSidebar } from "@/routes/chat/sidebar/SessionSidebar";
import { sessionSummary } from "@/preview/fixtures";

/**
 * The rows of the list come from the host (`list_sessions`), which no story can call.
 * The cache is seeded with the answer instead, so the story shows the landing of a
 * window that already knows its sessions.
 */
const sessions = [
    sessionSummary({ cwd: "/home/kui/Projects/pie", name: "Fix the parser" }),
    sessionSummary({ cwd: "/home/kui/Projects/pie", name: null, firstMessage: "what does this flag do?" }),
];

function Seeded({ sessions, children }: { sessions: SessionSummary[]; children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["sessions", "local"], sessions);
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The landing of the chat: the words of pi, the keys of the window, and the list
 * beside them.
 *
 * The rows name the window's keys; they are labels, not controls. The bindings
 * are not made yet (G22), so a key press does nothing here.
 */
const meta = {
    title: "Chat/SessionLanding",
    component: SessionLanding,
    parameters: { layout: "fullscreen", sessions },
    decorators: [
        (Story, context) => (
            <Seeded sessions={context.parameters.sessions as SessionSummary[]}>
                {/* The story is the window: `fixed` escapes the preview's centring and
                    keeps room around the page, and the router is what the way back to
                    the gate needs. */}
                <div className="fixed inset-0 flex font-sans">
                    <MemoryRouter>
                        {/* The frame and the list belong to the workspace, and a story of the
                            landing draws the same window it does (`ChatScreen`). */}
                        <ChatFrame
                            sidebar={
                                <SessionSidebar
                                    id="session"
                                    endpoint="local"
                                    attached={new Map()}
                                    onPick={() => undefined}
                                    onNew={() => undefined}
                                    wide
                                    column
                                    sheet={false}
                                    onOpenSheet={() => undefined}
                                />
                            }
                        >
                            {/* The bar is the window's, and no conversation is open: it carries
                                only the way to the list and the window's own keys. */}
                            <ChatTopbar start={<SidebarToggle onToggleSessions={() => undefined} />} />
                            <Story />
                        </ChatFrame>
                    </MemoryRouter>
                </div>
            </Seeded>
        ),
    ],
    args: {},
} satisfies Meta<typeof SessionLanding>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The window of a host that holds sessions: the list stands beside the landing. */
export const Landing: Story = {};
