// One report shape for the Android and Linux runs, so the artifacts of a run
// compare. `cases` and `summary` are the part a CI job reads.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {object} run
 * @param {"android" | "linux"} run.platform
 * @param {"mock" | "real"} run.profile
 * @param {string} run.address
 * @param {string} [run.serial] Android only
 */
export function createReport({ platform, profile, address, serial }) {
    return {
        startedAt: new Date().toISOString(),
        platform,
        profile,
        ...(serial === undefined ? {} : { serial }),
        address,
        cases: [],
    };
}

/** Adds the end time and the counted cases. */
export function finishReport(report) {
    report.finishedAt = new Date().toISOString();
    report.summary = {
        total: report.cases.length,
        passed: report.cases.filter((item) => item.status === "pass").length,
        failed: report.cases.filter((item) => item.status === "fail").length,
    };
    return report;
}

/** Rewrites report.json, so a run that dies mid-way keeps the cases it reported. */
export function writeReport(directory, report) {
    writeFileSync(join(directory, "report.json"), `${JSON.stringify(finishReport(report), null, 4)}\n`);
}

/** The case ID the spec puts at the start of its describe title. */
export function caseIdFromTitle(title) {
    const match = /^\s*([A-Z]+(?:-[A-Z0-9]+)+)\b/.exec(String(title ?? ""));
    return match === null ? null : match[1];
}
