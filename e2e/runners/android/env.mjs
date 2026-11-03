// The Android runner environment: paths, the mock host over SSH, the adb cold
// start, and the parsed command line. Page actions live in pages/; transport
// lives in cdp.mjs.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, clear, launch } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const E2E = join(ROOT, "e2e");
const COMPOSE = join(E2E, "compose.yaml");
const SSH_KEY = join(E2E, ".testenv/ssh/id_ed25519");
const SSH_KEY_PASSPHRASE = join(E2E, ".testenv/ssh/id_ed25519_passphrase");
const KNOWN_HOSTS = join(E2E, ".testenv/ssh/known_hosts");
const FINGERPRINT = readFileSync(join(E2E, ".testenv/ssh/host_fingerprint"), "utf8").trim();
const SESSIONS = "/home/pi/.pi/agent/sessions/--home-pi-work--";

const options = parseArgs(process.argv.slice(2));
const SERIAL = options.serial ?? process.env.PIE_ANDROID_SERIAL ?? "192.168.240.112:5555";
const PROFILE = options.profile === "real" ? "real" : "mock";
const HOST_PORT = PROFILE === "real" ? "2223" : "2222";
const ADDRESS = options.address ?? (PROFILE === "real" ? "pi@192.168.240.1:2223" : "pi@192.168.240.1:2222");
const PASSWORD = options.password ?? "pie-test";
const ARTIFACTS = options.artifacts ?? join(E2E, ".artifacts", new Date().toISOString().replace(/[:.]/g, "-"));
const PORT = Number(options.port ?? 9333);

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

function host(script, timeout = 20000) {
    return execFileSync(
        "ssh",
        [
            "-p",
            HOST_PORT,
            "-i",
            SSH_KEY,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            `UserKnownHostsFile=${KNOWN_HOSTS}`,
            "pi@127.0.0.1",
            script,
        ],
        { encoding: "utf8", timeout },
    );
}

function compose(...args) {
    return execFileSync("docker", ["compose", "-f", COMPOSE, ...args], {
        cwd: ROOT,
        encoding: "utf8",
    });
}

function sessionFiles() {
    const output = host(`ls -1t ${SESSIONS}/*.jsonl 2>/dev/null || true`).trim();
    return output === "" ? [] : output.split("\n");
}

function lineCount(path) {
    return Number(host(`wc -l < ${JSON.stringify(path)}`).trim());
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

function helloFile() {
    // The file is found by what it holds, not by its time: opening a session can
    // touch it, and the fixtures change order across a run.
    for (const file of sessionFiles()) {
        if (host(`grep -q '"text":"hello"' ${JSON.stringify(file)} && echo yes || echo no`).includes("yes")) {
            return file;
        }
    }
    throw new Error("no session carries the hello fixture");
}

export {
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
};
