// WebdriverIO configuration for the Linux desktop app. tauri-driver is started
// once for the whole run; every spec gets a fresh app-data sandbox.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createArtifacts, screenshotPath } from "../../support/artifacts.mjs";
import { resetHost } from "../../support/host.mjs";
import { resetSandboxFromEnv, createSandbox } from "../../support/sandbox.mjs";
import { startDriver, stopDriver } from "../../support/tauri-driver.mjs";
import { startXvfb, stopXvfb } from "../../support/xvfb.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const BIN = join(ROOT, "src-tauri/target/debug/pie");

let sandbox;
let xvfb;
let driver;
let artifacts;

export const config = {
    runner: "local",
    specs: ["./specs/desktop.e2e.mjs"],
    maxInstances: 1,
    capabilities: [
        {
            maxInstances: 1,
            "tauri:options": { application: BIN },
        },
    ],
    hostname: "127.0.0.1",
    port: 4444,
    path: "/",
    framework: "mocha",
    reporters: ["spec"],
    logLevel: "warn",
    connectionRetryCount: 0,
    waitforTimeout: 15_000,
    mochaOpts: {
        timeout: 90_000,
    },

    onPrepare: async () => {
        if (!existsSync(BIN)) {
            throw new Error("the debug binary is missing; run `pnpm tauri build --debug --no-bundle`");
        }
        if (process.env.PIE_E2E_NO_RESET !== "1") resetHost();

        artifacts = createArtifacts();
        process.env.PIE_E2E_ARTIFACTS = artifacts;
        sandbox = createSandbox();
        sandbox.apply();

        xvfb = await startXvfb();
        process.env.DISPLAY = xvfb.display;
        driver = await startDriver(process.env, { logPath: join(artifacts, "driver.log") });
    },

    beforeSession: async () => {
        if (process.env.PIE_E2E_PRESERVE_DATA === "1") {
            delete process.env.PIE_E2E_PRESERVE_DATA;
            return;
        }
        resetSandboxFromEnv();
    },

    afterTest: async (test, _context, { error }) => {
        if (error === undefined) return;
        try {
            await browser.saveScreenshot(screenshotPath(artifacts, `${test.parent} ${test.title}`));
        } catch {
            // A closed window has no screenshot; the spec reporter still names it.
        }
    },

    onComplete: async () => {
        stopDriver(driver);
        await stopXvfb(xvfb);
    },
};
