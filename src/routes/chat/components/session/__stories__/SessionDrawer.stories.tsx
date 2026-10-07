import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionSummary } from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { Panel } from "@/components/Panel";
import { SessionDrawer } from "@/routes/chat/components/session/SessionDrawer";
import { SessionSheet } from "@/routes/chat/components/session/SessionSheet";
import { sessionSummary } from "@/preview/fixtures";

/**
 * The rows of this panel come from the host (`list_sessions`), which no story can
 * call. Each story seeds the cache with the answer instead: that is what a read
 * leaves behind, and the panel then draws it without asking anyone.
 */
const sessions = [
    sessionSummary({ cwd: "/home/kui/Projects/pie", name: "Fix the parser" }),
    sessionSummary({ cwd: "/home/kui/Projects/pie", name: "Rewrite the drawer" }),
    sessionSummary({ cwd: "/home/kui/Projects/pie", name: null, firstMessage: "what does this flag do?" }),
    sessionSummary({ cwd: "/home/kui/Projects/other", name: "Notes on the release" }),
];

function Seeded({ sessions, children }: { sessions: SessionSummary[]; children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        // The same key the drawer reads, for the host the story's args name.
        client.setQueryData(["sessions", "local"], sessions);
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
    title: "Chat/SessionDrawer",
    component: SessionDrawer,
    parameters: { layout: "fullscreen", sessions },
    decorators: [
        (Story, context) => (
            <Seeded sessions={context.parameters.sessions as SessionSummary[]}>
                {/* The frame is the window. The preview of the app centres what it
                    shows and keeps room around it, and a panel that is the left
                    column of a window is not a centred thing: `fixed` is what
                    escapes that centring and lands at the viewport's own edge. */}
                <div className="fixed inset-0 flex items-stretch font-sans">
                    {/* The pane the drawer fills in the window: a panel of its own,
                        with the frame that a panel beside a neighbour carries. */}
                    <Panel id="session-panel" className="bg-surface-dim w-64 flex-none">
                        <Story />
                    </Panel>
                </div>
            </Seeded>
        ),
    ],
    args: {
        id: "session-drawer",
        endpoint: "local",
        currentSessionId: sessions[0].id,
        working: false,
        busy: false,
        onPick: () => undefined,
        // The app frames this pane with a `Panel` and mounts it from `lg` only; the
        // story's own frame stands in for both, so the drawer fills it.
        className: "flex-1",
    },
} satisfies Meta<typeof SessionDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The list of a host: the sessions of each directory together, newest first. */
export const Sessions: Story = {};

/**
 * The conversation of this window works: its own mark covers the attached one, and
 * the rows hold still while a switch would have to abort the run.
 */
export const Working: Story = {
    args: { working: true, busy: true },
};

/** A host that has said nothing yet: pi writes a session file only at a first turn. */
export const Empty: Story = {
    parameters: { sessions: [] },
};

/**
 * The same list of a narrow window: the sheet arrives from the edge it is anchored
 * to, with the left edge square and the right one round.
 *
 * A real window hides this sheet from `lg`, where the column stands instead — and
 * then a preview of any width would draw a scrim over nothing. The frame is pinned
 * open here so the phone shape stays reviewable from any window.
 */
export const AsSheet: Story = {
    render: (args) => (
        <SessionSheet id="session-sheet" open onOpenChange={() => undefined} className="lg:flex">
            <SessionDrawer {...args} className="h-full" />
        </SessionSheet>
    ),
};
