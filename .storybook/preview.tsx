import type { Preview } from "@storybook/react-vite";
import "../src/index.css";

const preview: Preview = {
    decorators: [
        (Story) => (
            <div className="bg-background text-foreground min-h-svh">
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
