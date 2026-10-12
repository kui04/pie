import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryDefaults } from "@/lib/query";
import { ThinkingLevelPicker, type ThinkingLevelPickerProps } from "@/routes/chat/composer/ThinkingLevelPicker";

/**
 * The popup reads the thinking levels of the session over the bridge, which no story can
 * call. The cache is seeded with the answer instead.
 */
function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "thinkingLevels"], {
            levels: ["off", "low", "medium", "high", "max"],
        });
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Whether the popup is open is the caller's state, and a snapshot's args cannot change
 * on a click: the story holds that state itself so the preview can open the popup.
 */
function Open({
    open: initial,
    ...props
}: Omit<ThinkingLevelPickerProps, "open" | "onOpenChange"> & { open: boolean }) {
    const [open, setOpen] = useState(initial);
    return <ThinkingLevelPicker {...props} open={open} onOpenChange={setOpen} />;
}

const meta = {
    title: "Chat/ThinkingLevelPicker",
    component: ThinkingLevelPicker,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <Seeded>
                <div className="bg-background fixed inset-x-0 bottom-0 px-3 py-6 font-sans">
                    <Story />
                </div>
            </Seeded>
        ),
    ],
    args: {
        session: "main:1",
        current: "medium",
        open: false,
        onOpenChange: () => undefined,
    },
    render: (args) => <Open {...args} />,
} satisfies Meta<typeof ThinkingLevelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The key, with the level that is in use. */
export const Chosen: Story = {};

/** The popup, open. */
export const ThinkingPanel: Story = { args: { open: true } };

/** A session before its first state read: the key stands on its fallback word. */
export const BeforeTheFirstRead: Story = { args: { current: null } };
