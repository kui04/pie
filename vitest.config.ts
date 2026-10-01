import { configDefaults, defineConfig } from "vitest/config";

// https://vitest.dev/config/
export default defineConfig({
    test: {
        environment: "happy-dom",
        setupFiles: ["./src/test/setup.ts"],
        exclude: [...configDefaults.exclude, ".codegraph/**", "src-tauri/**"],
    },
});
