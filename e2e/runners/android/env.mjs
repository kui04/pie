// The Android runner environment: the test host over SSH, the adb cold start,
// and the parsed command line. Page actions live in pages/; transport lives in
// cdp.mjs.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { E2E, FINGERPRINT, SSH_KEY, SSH_KEY_PASSPHRASE, createHost } from "../../support/host.mjs";
import { Cdp, clear, launch, stop } from "./cdp.mjs";

const options = parseArgs(process.argv.slice(2));
const SERIAL = options.serial ?? process.env.PIE_ANDROID_SERIAL ?? "192.168.240.112:5555";
const PROFILE = options.profile === "real" ? "real" : "mock";
const HOST_PORT = PROFILE === "real" ? "2223" : "2222";
const ADDRESS = options.address ?? (PROFILE === "real" ? "pi@192.168.240.1:2223" : "pi@192.168.240.1:2222");
const PASSWORD = options.password ?? "pie-test";
const ARTIFACTS = options.artifacts ?? join(E2E, ".artifacts", new Date().toISOString().replace(/[:.]/g, "-"));
const PORT = Number(options.port ?? 9333);

// The app names the host as the device sees it; ssh on this machine reaches the
// same Docker host on the published port.
const local = createHost({ address: `pi@127.0.0.1:${HOST_PORT}` });
const { compose, expectFixtures, helloFile, lineCount, restoreFixtures, run: host, sessionFiles } = local;

mkdirSync(join(ARTIFACTS, "screens"), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
    const parsed = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--")) continue;
        const [name, inline] = arg.slice(2).split("=");
        const next = argv[i + 1];
        parsed[name] = inline ?? (next === undefined || next.startsWith("--") ? true : next);
        if (inline === undefined && parsed[name] !== true) i += 1;
    }
    return parsed;
}

async function coldStart() {
    clear(SERIAL);
    launch(SERIAL);
    const cdp = await Cdp.find(SERIAL, PORT);
    await cdp.waitFor("document.body.innerText.includes('Connect to pi')", {
        what: "the connect screen",
        timeoutMs: 20000,
    });
    return cdp;
}

/** Stops the app of the previous case before its fixtures are restored. */
function stopApp() {
    stop(SERIAL);
}

export {
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
};
