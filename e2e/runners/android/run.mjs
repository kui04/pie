#!/usr/bin/env node
// Drives the Android debug build through adb and the WebView DevTools protocol.
// Cases live under cases/; this file only selects, runs, and reports them.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    ADDRESS,
    ARTIFACTS,
    E2E,
    FINGERPRINT,
    PASSWORD,
    PORT,
    PROFILE,
    ROOT,
    SERIAL,
    SSH_KEY,
    SSH_KEY_PASSPHRASE,
    coldStart,
    compose,
    helloFile,
    host,
    lineCount,
    options,
    sessionFiles,
    sleep,
} from "./env.mjs";
import { createAndroidApp } from "../../apps/android.mjs";
import { cases, realCases } from "../../cases/index.mjs";
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
    if (PROFILE !== "real" && options["no-reset"] === undefined) {
        execFileSync("bash", [join(E2E, "reset-host.sh")], {
            cwd: ROOT,
            encoding: "utf8",
        });
    }

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
    const report = {
        startedAt: new Date().toISOString(),
        serial: SERIAL,
        address: ADDRESS,
        cases: [],
    };
    let app;
    let failed = 0;
    let known = 0;

    for (const item of selected) {
        const started = Date.now();
        const limit = item.timeoutMs ?? 90_000;
        const context = contextFor(item);
        let status = "pass";
        let error;
        try {
            app?.close();
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
            status = item.knownBug === undefined ? "fail" : "known";
            if (status === "fail") failed += 1;
            else known += 1;
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
            status,
            error,
            ms: Date.now() - started,
        };
        if (item.knownBug !== undefined) record.bug = item.knownBug;
        report.cases.push(record);
        const line = `${record.status.toUpperCase().padEnd(5)} ${record.id} ${record.name}`;
        console.log(error === undefined ? line : `${line}\n      ${error}`);
    }

    report.finishedAt = new Date().toISOString();
    report.summary = {
        total: report.cases.length,
        passed: report.cases.filter((c) => c.status === "pass").length,
        failed,
        known,
    };
    writeFileSync(join(ARTIFACTS, "report.json"), `${JSON.stringify(report, null, 4)}\n`);
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
        `\n${report.summary.passed}/${report.summary.total} passed, ${failed} failed, ${known} known (${ARTIFACTS})`,
    );
    app?.close();
    process.exit(failed === 0 ? 0 : 1);
}

await main();
