// The SSH reach to the test host and its deterministic session fixtures. One
// factory serves both runners: the Linux suite reaches the host the app names,
// the Android suite reaches the same Docker host on its published port.

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
export const SSH_KEY = join(E2E, ".testenv/ssh/id_ed25519");
export const SSH_KEY_PASSPHRASE = join(E2E, ".testenv/ssh/id_ed25519_passphrase");
export const FINGERPRINT = readFileSync(join(E2E, ".testenv/ssh/host_fingerprint"), "utf8").trim();
const KNOWN_HOSTS = join(E2E, ".testenv/ssh/known_hosts");

/**
 * Splits a login address, `user@host` or `user@host:port`, into the parts ssh
 * takes. A port that is not given defaults to 22.
 */
export function parseAddress(address) {
    const trimmed = String(address).trim();
    const at = trimmed.indexOf("@");
    if (at <= 0) throw new Error(`the address has no user: ${JSON.stringify(trimmed)}`);
    const user = trimmed.slice(0, at);
    if (user.includes(":")) throw new Error(`the address names a port in the user: ${JSON.stringify(trimmed)}`);
    const rest = trimmed.slice(at + 1);
    const colon = rest.lastIndexOf(":");
    const host = colon < 0 ? rest : rest.slice(0, colon);
    const port = colon < 0 ? "22" : rest.slice(colon + 1);
    if (host === "" || host.includes(":") || !/^\d+$/.test(port)) {
        throw new Error(`the address is not user@host:port: ${JSON.stringify(trimmed)}`);
    }
    return { user, host, port };
}

/**
 * The commands a case runs on the test host, and the fixtures it reads back.
 *
 * @param {object} options
 * @param {string} options.address the login address of the host
 */
export function createHost({ address }) {
    const target = parseAddress(address);

    function run(script, timeout = 20_000) {
        return execFileSync(
            "ssh",
            [
                "-p",
                target.port,
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
                `${target.user}@${target.host}`,
                script,
            ],
            { encoding: "utf8", timeout },
        );
    }

    function sessionFiles() {
        const output = run(`ls -1t ${SESSIONS}/*.jsonl 2>/dev/null || true`).trim();
        return output === "" ? [] : output.split("\n");
    }

    function lineCount(path) {
        return Number(run(`wc -l < ${JSON.stringify(path)}`).trim());
    }

    function fixtureFile(name) {
        // A fixture is the session the entrypoint recorded under that name. The
        // session_info record holds it; tool names repeat, so the type must match
        // that record and not a tool call.
        const marker = `"name":"${name}"`;
        for (const file of sessionFiles()) {
            const info = `grep -Fq '"type":"session_info"' ${JSON.stringify(file)}`;
            const named = `grep -Fq ${JSON.stringify(marker)} ${JSON.stringify(file)}`;
            if (run(`${info} && ${named} && echo yes || echo no`).includes("yes")) return file;
        }
        throw new Error(`no session carries the ${name} fixture`);
    }

    function helloFile() {
        return fixtureFile("hello");
    }

    function expectFixtures(names) {
        for (const name of names ?? []) fixtureFile(name);
    }

    function compose(...args) {
        return execFileSync("docker", ["compose", "-f", join(E2E, "compose.yaml"), ...args], {
            cwd: ROOT,
            encoding: "utf8",
        });
    }

    function restoreFixtures() {
        try {
            execFileSync("bash", [join(E2E, "reset-host.sh")], { cwd: ROOT, encoding: "utf8" });
        } catch (problem) {
            const reason = String(problem.stderr ?? "").trim() || String(problem.message ?? problem);
            throw new Error(`the host did not restore its fixtures: ${reason}`, { cause: problem });
        }
    }

    return { run, sessionFiles, lineCount, fixtureFile, helloFile, expectFixtures, compose, restoreFixtures };
}

/** The mock host the Linux suite reaches, named by the address its app uses. */
const local = createHost({ address: ADDRESS });

export const host = local.run;
export const { compose, expectFixtures, fixtureFile, helloFile, lineCount, restoreFixtures, sessionFiles } = local;
