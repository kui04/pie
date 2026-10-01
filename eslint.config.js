import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig(
    // eslint does not read .gitignore, and a bare `target` does not match the files
    // inside it: Tauri's generated assets under src-tauri/target are not valid
    // JavaScript, so build output needs an explicit glob, next to the generated
    // Android project and the pi reference checkout.
    { ignores: ["dist", "storybook-static", "**/target/**", "src-tauri/gen", ".codegraph"] },
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
    prettierConfig,
);
