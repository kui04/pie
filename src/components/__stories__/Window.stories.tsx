import type { Meta, StoryObj } from "@storybook/react-vite";
import { Window } from "@/components/Window";
import { SessionHeader } from "@/routes/chat/components/session/SessionHeader";
import { sessionStats } from "@/preview/fixtures";

/**
 * The window both screens draw: the gate's, which carries only the window's keys,
 * and a session's, with the list's column and the session's slots in the bar.
 *
 * The bar is the drag region of a window without decorations; here it is only a
 * picture of one.
 */

const meta = {
    title: "Chrome/Window",
    component: Window,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <div className="fixed inset-0 flex font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Window>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The gate: no list, so the bar is the window's own keys and nothing else. */
export const Gate: Story = {};

/** A session: the list's column, and the session's slots before the keys. */
export const Session: Story = {
    args: {
        sidebar: (
            <div id="sidebar" className="bg-surface-dim border-border flex w-64 flex-none flex-col border-r p-2">
                <p className="text-body-md text-muted-foreground">The session list</p>
            </div>
        ),
        topbar: (
            <SessionHeader
                name="Fix the parser"
                cwd="/home/kui/Projects/pie"
                stats={sessionStats()}
                auto={false}
                onToggleSessions={() => undefined}
            />
        ),
        children: (
            <div className="flex flex-col gap-3 p-3">
                <p className="bg-card text-body-md rounded-md p-3">A tile, as a tool result draws one.</p>
                <p className="text-body-md text-muted-foreground px-1">A line of the transcript.</p>
            </div>
        ),
    },
};
