// One report directory per Linux run, with failure screenshots beside it.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const E2E = join(HERE, "..");

export function createArtifacts() {
    const directory = join(E2E, ".artifacts", new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(join(directory, "screens"), { recursive: true });
    return directory;
}

export function screenshotPath(directory, title) {
    const name = title.replace(/[^a-zA-Z0-9_-]+/g, "-");
    return join(directory, "screens", `${name}-failed.png`);
}
