import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryDefaults } from "@/lib/query";
import { ModelPicker, type ModelPickerProps } from "@/routes/chat/composer/ModelPicker";
import { model } from "@/preview/fixtures";

/**
 * The popup reads the models of the session and the marks of their providers over
 * the bridge, which no story can call. The cache is seeded with both answers
 * instead: the marks are the shape the picker draws, and a provider without one
 * shows the fallback key.
 */
function Seeded({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "models"], {
            models: [
                model(),
                model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }),
                model({ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }),
                // A host can serve more models than the popup's height holds: the list has
                // to scroll past them rather than grow or clip.
                ...Array.from({ length: 21 }, (_, index) =>
                    model({
                        id: `model-${index}`,
                        name: `A-very-long-model-name ${index}`,
                        provider: "a-local-host",
                    }),
                ),
            ],
        });
        for (const provider of ["anthropic", "deepseek"]) {
            client.setQueryData(["provider-logo", provider], MARK);
        }
        for (const provider of ["openai", "a-local-host"]) {
            client.setQueryData(["provider-logo", provider], null);
        }
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * A mark for the stories: the shape the picker draws. The real ones come from
 * models.dev over the bridge, which no story can call.
 */
const MARK =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJsMi45IDYuNiA3LjEuNy01LjQgNC44IDEuNiA3TDEyIDE3LjYgNS44IDIxLjFsMS42LTdMMiA5LjNsNy4xLS43eiIvPjwvc3ZnPg==";

/**
 * Whether the popup is open is the caller's state, and a snapshot's args cannot change
 * on a click: the story holds that state itself so the preview can open the popup.
 */
function Open({ open: initial, ...props }: Omit<ModelPickerProps, "open" | "onOpenChange"> & { open: boolean }) {
    const [open, setOpen] = useState(initial);
    return <ModelPicker {...props} open={open} onOpenChange={setOpen} />;
}

const meta = {
    title: "Chat/ModelPicker",
    component: ModelPicker,
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
        current: model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }),
        open: false,
        onOpenChange: () => undefined,
    },
    render: (args) => <Open {...args} />,
} satisfies Meta<typeof ModelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The key, with the model that is in use. */
export const Chosen: Story = {};

/** The popup, open: a search row over the list, the model in use checked. */
export const ModelPanel: Story = { args: { open: true } };

/** A session before its first state read: the key stands on its fallback word. */
export const BeforeTheFirstRead: Story = { args: { current: null } };
