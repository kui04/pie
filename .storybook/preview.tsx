import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import "../src/index.css";

/**
 * One client for one story: a module-level client would carry a session or a
 * connection from the story before it, and a story is meant to start clean.
 */
// eslint-disable-next-line react-refresh/only-export-components -- a config file has no refresh to protect
function WithQuery({ children }: { children: React.ReactNode }) {
    const [client] = useState(() => new QueryClient());
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const preview: Preview = {
    decorators: [
        (Story) => (
            <WithQuery>
                <div className="flex min-h-svh min-w-svw items-center justify-center p-6">
                    <Story />
                </div>
            </WithQuery>
        ),
    ],
    parameters: {
        controls: {
            matchers: {
                color: /(background|color)$/i,
                date: /Date$/i,
            },
        },
    },
};

export default preview;
