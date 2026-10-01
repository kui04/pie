import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// https://vitest.dev/config/
export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    test: {
        environment: "happy-dom",
        setupFiles: ["./src/test/setup.ts"],
        exclude: [...configDefaults.exclude, ".codegraph/**", "src-tauri/**"],
    },
});
