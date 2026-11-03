// SSH helpers and the deterministic session fixtures of the mock host.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const E2E = resolve(HERE, "..");
export const ROOT = resolve(E2E, "..");
export const ADDRESS = process.env.PIE_E2E_LINUX_ADDRESS ?? "pi@127.0.0.1:2222";
export const PASSWORD = process.env.PIE_E2E_LINUX_PASSWORD ?? "pie-test";
export const SESSIONS = "/home/pi/.pi/agent/sessions/--home-pi-work--";
const KNOWN_HOSTS = join(E2E, ".testenv/ssh/known_hosts");
export const SSH_KEY = join(E2E, ".testenv/ssh/id_ed25519");
export const SSH_KEY_PASSPHRASE = join(E2E, ".testenv/ssh/id_ed25519_passphrase");
export const FINGERPRINT = readFileSync(join(E2E, ".testenv/ssh/host_fingerprint"), "utf8").trim();

export function host(script, timeout = 20_000) {
    return execFileSync(
        "ssh",
        [
            "-p",
            "2222",
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

export function sessionFiles() {
    const output = host(`ls -1t ${SESSIONS}/*.jsonl 2>/dev/null || true`).trim();
    return output === "" ? [] : output.split("\n");
}

export function lineCount(path) {
    return Number(host(`wc -l < ${JSON.stringify(path)}`).trim());
}

export function helloFile() {
    for (const file of sessionFiles()) {
        if (host(`grep -q '"text":"hello"' ${JSON.stringify(file)} && echo yes || echo no`).includes("yes")) {
            return file;
        }
    }
    throw new Error("no session carries the hello fixture");
}

export function resetHost() {
    execFileSync("bash", [join(E2E, "reset-host.sh")], {
        cwd: ROOT,
        stdio: "inherit",
    });
}

export function compose(...args) {
    return execFileSync("docker", ["compose", "-f", join(E2E, "compose.yaml"), ...args], {
        cwd: ROOT,
        encoding: "utf8",
    });
}
