import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import eslintPluginTailwindcss from "eslint-plugin-tailwindcss";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig(
    // eslint does not read .gitignore. A bare `target` does not match the files
    // in it. Therefore the build output needs an explicit glob. The glob also
    // covers the generated Android project and the pi reference checkout.
    { ignores: ["dist", "storybook-static", "**/target/**", "src-tauri/gen", ".codegraph", ".agents/skills"] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            ecmaVersion: 2020,
            globals: globals.browser,
        },
        plugins: {
            "react-hooks": reactHooks,
            "react-refresh": reactRefresh,
        },
        rules: {
            ...reactHooks.configs.flat["recommended-latest"].rules,
            "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
            // A plugin reaches the machine through the permissions in the
            // capability file. Rust makes the decisions of pie. Therefore the
            // frontend gets what it needs from a command of pie. See
            // `.agents/rules/architecture.md`.
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["@tauri-apps/plugin-*"],
                            message: "a Tauri plugin is Rust's to call; export a command instead (architecture.md).",
                        },
                    ],
                },
            ],
        },
    },
    {
        // Generated shadcn primitives export variant maps next to their
        // components; that is the upstream pattern, not a fast-refresh bug.
        files: ["src/components/ui/**/*.{ts,tsx}"],
        rules: {
            "react-refresh/only-export-components": "off",
        },
    },
    {
        // The test scripts in src-tauri/tests/scripts are Node programs, not
        // browser code.
        extends: [js.configs.recommended],
        files: ["src-tauri/tests/scripts/**/*.mjs"],
        languageOptions: {
            ecmaVersion: 2022,
            globals: globals.node,
        },
    },
    {
        // Tailwind's own rule set, resolved against this app's stylesheet. The shadcn
        // primitives are left out: they are the registry's bytes, which `pnpm ui-check` holds.
        files: ["src/**/*.{ts,tsx}"],
        ignores: ["src/components/ui/**"],
        extends: [eslintPluginTailwindcss.configs.recommended],
        settings: { tailwindcss: { cssConfigPath: "./src/index.css" } },
        rules: {
            // `src/components/Markdown.tsx` sets its heading sizes with arbitrary values
            // (`text-[20px]`, `leading-[1.3]`). This rule offers a line-height token for a font
            // size, and `leading-1.3`, which is not a class. Its fixes cannot be trusted.
            "tailwindcss/no-unnecessary-arbitrary-value": "off",
        },
    },
    prettierConfig,
);
