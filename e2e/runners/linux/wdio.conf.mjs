// WebdriverIO configuration for the Linux desktop app. tauri-driver is started
// once for the whole run; every spec gets a fresh app-data sandbox.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cases } from "../../cases/index.mjs";
import { createArtifacts, screenshotPath } from "../../support/artifacts.mjs";
import { ADDRESS } from "../../support/host.mjs";
import { caseIdFromTitle, createReport, writeReport } from "../../support/report.mjs";
import { resetSandboxFromEnv, createSandbox } from "../../support/sandbox.mjs";
import { startDriver, stopDriver } from "../../support/tauri-driver.mjs";
import { startXvfb, stopXvfb } from "../../support/xvfb.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const BIN = join(ROOT, "src-tauri/target/debug/pie");
const PRIORITIES = new Map(cases.map((item) => [item.id, item.priority]));

// The launcher creates the artifact directory before it spawns this worker, so
// the worker finds the path in its environment. The launcher runs no test and
// keeps no report of its own.
const WORKER_ARTIFACTS = process.env.PIE_E2E_ARTIFACTS;
let report =
    WORKER_ARTIFACTS === undefined ? undefined : createReport({ platform: "linux", profile: "mock", address: ADDRESS });

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

        artifacts = createArtifacts();
        process.env.PIE_E2E_ARTIFACTS = artifacts;
        sandbox = createSandbox();
        sandbox.apply();

        xvfb = await startXvfb();
        process.env.DISPLAY = xvfb.display;
        // A Wayland socket in the developer's session lets WebKitGTK ignore the
        // private X display, and a tiling compositor then makes the window wide.
        delete process.env.WAYLAND_DISPLAY;
        process.env.GDK_BACKEND = "x11";
        driver = await startDriver(process.env, { logPath: join(artifacts, "driver.log") });
    },

    beforeSession: async () => {
        if (process.env.PIE_E2E_PRESERVE_DATA === "1") {
            delete process.env.PIE_E2E_PRESERVE_DATA;
            return;
        }
        resetSandboxFromEnv();
    },

    afterTest: async (test, _context, { error, passed, duration }) => {
        if (report === undefined) {
            throw new Error("PIE_E2E_ARTIFACTS is unset; run the suite through e2e/run.sh");
        }
        const id = caseIdFromTitle(test.parent);
        const record = {
            id: id ?? test.title,
            priority: id === null ? null : (PRIORITIES.get(id) ?? null),
            name: test.title,
            status: passed ? "pass" : "fail",
            error: error === undefined ? undefined : String(error.message ?? error),
            ms: Math.round(duration),
        };
        report.cases.push(record);
        writeReport(WORKER_ARTIFACTS, report);
        if (error === undefined) return;
        try {
            await browser.saveScreenshot(screenshotPath(WORKER_ARTIFACTS, record.id));
        } catch {
            // A closed window has no screenshot; the spec reporter still names it.
        }
    },

    onComplete: async () => {
        // The worker writes report.json after every test; a run that started no
        // test still gets one.
        if (artifacts !== undefined && !existsSync(join(artifacts, "report.json"))) {
            writeReport(artifacts, createReport({ platform: "linux", profile: "mock", address: ADDRESS }));
        }
        stopDriver(driver);
        await stopXvfb(xvfb);
    },
};
