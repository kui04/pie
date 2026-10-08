import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryDefaults } from "@/lib/query";
import { ModePickers, type ComposerPanel, type ModePickersProps } from "@/routes/chat/components/composer/ModePickers";
import { model } from "@/preview/fixtures";

/**
 * The panels read the models and the levels of the session over the bridge, which no
 * story can call. The cache is seeded with both answers instead.
 */
function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "models"], {
            models: [
                model(),
                model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }),
                model({ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }),
            ],
        });
        client.setQueryData(["session", "main:1", "thinkingLevels"], {
            levels: ["off", "low", "medium", "high", "max"],
        });
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The panels are one-at-a-time state, and a snapshot's args cannot change on a click:
 * the story holds that state itself so the preview can open either one.
 */
function Open({
    panel: initial,
    ...props
}: Omit<ModePickersProps, "panel" | "onOpenChange"> & { panel: ComposerPanel }) {
    const [panel, setPanel] = useState<ComposerPanel>(initial);
    return <ModePickers {...props} panel={panel} onOpenChange={setPanel} />;
}

const meta = {
    title: "Chat/ModePickers",
    component: ModePickers,
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
        model: model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }),
        thinking: "medium",
        panel: null,
        onOpenChange: () => undefined,
    },
    render: (args) => <Open {...args} />,
} satisfies Meta<typeof ModePickers>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Both keys of the control row, with the model and the level that are in use. */
export const Chosen: Story = {};

/** The model panel, open: a search row over the list, the model in use checked. */
export const ModelPanel: Story = { args: { panel: "model" } };

/** The thinking panel, open. */
export const ThinkingPanel: Story = { args: { panel: "thinking" } };

/** A session before its first state read: both keys stand on their fallback words. */
export const BeforeTheFirstRead: Story = { args: { model: null, thinking: null } };
