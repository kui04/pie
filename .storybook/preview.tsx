import type { Preview } from "@storybook/react-vite";
import "../src/index.css";

const preview: Preview = {
    decorators: [
        (Story) => (
            <div className="flex min-h-svh min-w-svw items-center justify-center p-6">
                <Story />
            </div>
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
