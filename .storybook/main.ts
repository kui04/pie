import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
    stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
    addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
    framework: "@storybook/react-vite",
    // The builder does not read vite.config.ts, so its dev-server watcher
    // ignores must live here: without them, rustdoc output under
    // src-tauri/target/doc floods Vite with page reloads and kills HMR.
    viteFinal: (config) => {
        config.server = {
            ...config.server,
            watch: {
                ...config.server?.watch,
                ignored: [
                    "**/node_modules/**",
                    "**/.git/**",
                    "**/test-results/**",
                    "**/src-tauri/**",
                    "**/.codegraph/**",
                    "**/.devenv/**",
                    "**/.direnv/**",
                ],
            },
        };
        return config;
    },
};

export default config;
