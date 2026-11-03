#!/usr/bin/env node
// Drives the Android debug build through adb and the WebView DevTools protocol.
// Cases live under cases/; this file only selects, runs, and reports them.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    ADDRESS,
    ARTIFACTS,
    FINGERPRINT,
    PASSWORD,
    PORT,
    PROFILE,
    SERIAL,
    SSH_KEY,
    SSH_KEY_PASSPHRASE,
    coldStart,
    compose,
    expectFixtures,
    helloFile,
    host,
    lineCount,
    options,
    restoreFixtures,
    sessionFiles,
    sleep,
    stopApp,
} from "./env.mjs";
import { createAndroidApp } from "../../apps/android.mjs";
import { cases, realCases } from "../../cases/index.mjs";
import { createReport, writeReport } from "../../support/report.mjs";
import { selectCases } from "../../support/select.mjs";

const KEYS = {
    privateKey: readFileSync(SSH_KEY, "utf8"),
    passphraseKey: readFileSync(SSH_KEY_PASSPHRASE, "utf8"),
    passphrase: "pie-test-passphrase",
};

function contextFor(item) {
    return {
        platform: "android",
        profile: PROFILE,
        address: ADDRESS,
        password: PASSWORD,
        fingerprint: FINGERPRINT,
        keys: KEYS,
        host: { run: host, compose, sessionFiles, lineCount, helloFile },
        artifacts: ARTIFACTS,
        serial: SERIAL,
        sleep,
        case: item,
    };
}

async function main() {
    const selected = selectCases(PROFILE === "real" ? realCases : cases, {
        platform: "android",
        cases: options.cases,
        tags: options.tags,
        priority: options.priority,
    });
    if (selected.length === 0) {
        console.error("e2e: no Android case matches the filter");
        process.exit(2);
    }
    const report = createReport({
        platform: "android",
        profile: PROFILE,
        address: ADDRESS,
        serial: SERIAL,
    });
    let app;

    for (const item of selected) {
        const started = Date.now();
        const limit = item.timeoutMs ?? 90_000;
        const context = contextFor(item);
        let error;
        try {
            app?.close();
            // The app of the previous case must stop before its fixtures are
            // restored; the real host keeps its sessions across cases.
            stopApp();
            if (PROFILE !== "real" && options["no-reset"] === undefined) restoreFixtures();
            expectFixtures(item.fixtures);
            const cdp = await coldStart();
            app = createAndroidApp(cdp, context, { serial: SERIAL, port: PORT });
            await Promise.race([
                item.run(app, context),
                new Promise((_, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error(`the case did not finish within ${limit / 1000}s`)),
                        limit,
                    );
                    timer.unref();
                }),
            ]);
        } catch (problem) {
            error = String(problem.message ?? problem);
            try {
                await app?.screenshot(join(ARTIFACTS, "screens", `${item.id}-failed.png`));
            } catch {
                // A dead WebView leaves no screenshot; the report still names the case.
            }
        }
        const record = {
            id: item.id,
            priority: item.priority,
            name: item.name,
            status: error === undefined ? "pass" : "fail",
            error,
            ms: Date.now() - started,
        };
        report.cases.push(record);
        const line = `${record.status.toUpperCase().padEnd(5)} ${record.id} ${record.name}`;
        console.log(error === undefined ? line : `${line}\n      ${error}`);
    }

    writeReport(ARTIFACTS, report);
    try {
        writeFileSync(
            join(ARTIFACTS, "logcat.txt"),
            execFileSync("adb", ["-s", SERIAL, "logcat", "-d", "-t", "4000"], {
                encoding: "utf8",
            }),
        );
    } catch {
        // A device that left mid-run still keeps the report.
    }
    console.log(
        `\n${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed (${ARTIFACTS})`,
    );
    app?.close();
    process.exit(report.summary.failed === 0 ? 0 : 1);
}

await main();
