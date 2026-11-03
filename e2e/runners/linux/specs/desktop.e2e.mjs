import { readFileSync } from "node:fs";
import {
    ADDRESS,
    FINGERPRINT,
    PASSWORD,
    SSH_KEY,
    SSH_KEY_PASSPHRASE,
    compose,
    helloFile,
    host,
    lineCount,
    sessionFiles,
} from "../../../support/host.mjs";
import { cases } from "../../../cases/index.mjs";
import { resetSandboxFromEnv } from "../../../support/sandbox.mjs";
import { selectCases } from "../../../support/select.mjs";
import { createLinuxApp } from "../../../apps/linux.mjs";

const selected = selectCases(cases, { platform: "linux" });
if (selected.length === 0) throw new Error("no Linux case is registered");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYS = {
    privateKey: readFileSync(SSH_KEY, "utf8"),
    passphraseKey: readFileSync(SSH_KEY_PASSPHRASE, "utf8"),
    passphrase: "pie-test-passphrase",
};

function contextFor(item) {
    return {
        platform: "linux",
        profile: "mock",
        address: ADDRESS,
        password: PASSWORD,
        fingerprint: FINGERPRINT,
        keys: KEYS,
        host: { run: host, compose, sessionFiles, lineCount, helloFile },
        artifacts: process.env.PIE_E2E_ARTIFACTS,
        sleep,
        case: item,
    };
}

let first = true;

beforeEach(async () => {
    if (!first) {
        // End the old app before its data is removed; the next session starts on
        // empty app data, as the Android runner's pm clear does.
        await browser.deleteSession();
        delete process.env.PIE_E2E_PRESERVE_DATA;
        resetSandboxFromEnv();
        await browser.reloadSession();
    }
    first = false;
    await browser.setWindowSize(800, 600);
});

for (const item of selected) {
    describe(`${item.id}: ${item.name}`, () => {
        it(item.name, async function () {
            this.timeout(item.timeoutMs ?? 90_000);
            const context = contextFor(item);
            const app = createLinuxApp(browser, context);
            await item.run(app, context);
        });
    });
}
