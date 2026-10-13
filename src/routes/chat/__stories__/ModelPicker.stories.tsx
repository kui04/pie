import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { queryDefaults } from "@/lib/query";
import { ModelPicker, type ModelPickerProps } from "@/routes/chat/composer/ModelPicker";
import { model } from "@/preview/fixtures";

/**
 * The popup reads the models of the session and the marks of their providers over
 * the bridge, which no story can call. The cache is seeded with both answers
 * instead: the marks are the shape the picker draws, and a provider without one
 * shows the fallback key.
 */
function Seeded({ children, count = 24 }: { children: ReactNode; count?: number }) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        client.setQueryData(["session", "main:1", "models"], {
            models: [
                model(),
                model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }),
                model({ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }),
                // A host can serve more models than the popup's height holds: the list has
                // to scroll past them rather than grow or clip.
                ...Array.from({ length: count - 3 }, (_, index) =>
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

/**
 * The popup's read held on its way. A query cannot be held through the cache - the query of
 * the popup carries its own fetch - so the reader is counted offline, which pauses it: the
 * offline state is set while the story renders, before the popup of the child asks.
 */
function Waiting({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
        onlineManager.setOnline(false);
        return new QueryClient(queryDefaults);
    });
    useEffect(() => () => onlineManager.setOnline(true), []);
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A client with nothing in it, and a bridge no story can reach: every read of it fails. */
function Fresh({ children }: { children: ReactNode }) {
    const [client] = useState(() => new QueryClient(queryDefaults));
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
    title: "Chat/ModelPicker",
    component: ModelPicker,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story, context) => {
            const models = context.parameters.models;
            const panel = (
                <div className="bg-background fixed inset-x-0 bottom-0 px-3 py-6 font-sans">
                    <Story />
                </div>
            );
            if (models === "waiting") return <Waiting>{panel}</Waiting>;
            if (models === "failed") return <Fresh>{panel}</Fresh>;
            return <Seeded count={typeof models === "number" ? models : 24}>{panel}</Seeded>;
        },
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

/**
 * A host with every provider configured, as a real one can be: more models than the
 * popup could ever hold, and all of them in the list.
 */
export const AWholeHost: Story = { args: { open: true }, parameters: { models: 620 } };

/** The popup before the catalog of the host has arrived: the rows it waits for, as bars. */
export const WaitingForTheCatalog: Story = { args: { open: true }, parameters: { models: "waiting" } };

/** The popup when the catalog cannot be read: it says so, rather than naming an empty search. */
export const WhenTheCatalogCannotBeRead: Story = { args: { open: true }, parameters: { models: "failed" } };
