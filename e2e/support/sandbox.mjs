// A temporary HOME and XDG tree, so a test never touches the user's app data.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SANDBOX_KEYS = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];

export function resetSandboxFromEnv() {
    for (const key of SANDBOX_KEYS) {
        const dir = process.env[key];
        if (dir === undefined) continue;
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
    }
}

export function createSandbox() {
    const root = mkdtempSync(join(tmpdir(), "pie-linux-e2e-"));
    const paths = {
        HOME: join(root, "home"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
    };
    for (const dir of Object.values(paths)) {
        mkdirSync(dir, { recursive: true });
    }
    return {
        root,
        apply() {
            Object.assign(process.env, paths);
        },
        reset: resetSandboxFromEnv,
    };
}
