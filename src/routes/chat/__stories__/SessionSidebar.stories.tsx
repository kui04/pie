import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionSummary } from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { SessionSidebar } from "@/routes/chat/sidebar/SessionSidebar";
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
        // The same key the sidebar reads, for the host the story's args name.
        client.setQueryData(["sessions", "local"], sessions);
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
    title: "Chat/SessionSidebar",
    component: SessionSidebar,
    parameters: { layout: "fullscreen", sessions },
    decorators: [
        (Story, context) => (
            <Seeded sessions={context.parameters.sessions as SessionSummary[]}>
                {/* The frame is the window. The preview of the app centres what it
                    shows and keeps room around it, and a column that is the left
                    edge of a window is not a centred thing: `fixed` is what escapes
                    that centring and lands at the viewport's own edge. */}
                <div className="fixed inset-0 flex items-stretch font-sans">
                    {/* The column the sidebar draws in the window: it carries its own
                        surface and the hairline that parts it from the chat. */}
                    <Story />
                </div>
            </Seeded>
        ),
    ],
    args: {
        id: "session",
        endpoint: "local",
        // The first row's conversation is held by a session, and that session is not running.
        attached: new Map([[sessions[0].path, { session: "main:1", working: false }]]),
        onPick: () => undefined,
        wide: true,
        column: true,
        sheet: false,
        onOpenSheet: () => undefined,
    },
} satisfies Meta<typeof SessionSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The list of a host, as the column beside the chat: each directory together, newest first. */
export const Sessions: Story = {};

/**
 * A session works: the mark of the row it holds says so, and the breathing light is the only
 * thing in the row that moves.
 */
export const Working: Story = {
    args: { attached: new Map([[sessions[0].path, { session: "main:1", working: true }]]) },
};

/** A host that has said nothing yet: pi writes a session file only at a first turn. */
export const Empty: Story = {
    parameters: { sessions: [] },
};

/**
 * A host with a year of work on it: the list is longer than the pane, so this is
 * the story that shows what happens at the pane's foot - the list scrolls, and the
 * bar is only there while it moves.
 */
export const Many: Story = {
    parameters: {
        sessions: Array.from({ length: 30 }, (_, index) =>
            sessionSummary({
                cwd: index % 3 === 0 ? "/home/kui/Projects/pie" : "/home/kui/Projects/other",
                name: `A session name long enough that the row has to truncate it, number ${index + 1}`,
                path: `/home/kui/.pi/sessions/session-${index + 1}.jsonl`,
            }),
        ),
    },
};

/**
 * The same list of a narrow window: the sheet arrives from the edge it is anchored
 * to, with the left edge square and the right one round.
 *
 * A real window hides this sheet from `lg`, where the column stands instead — and
 * then a preview of any width would draw a scrim over nothing. The sheet is pinned
 * open here so the phone shape stays reviewable from any window.
 */
export const AsSheet: Story = {
    args: {
        wide: false,
        column: false,
        sheet: true,
        sheetClassName: "lg:flex",
    },
};
