// Speaks the RPC mode of pi over SSH, as the app does, and checks what a
// successful startup answers.

import { spawn } from "node:child_process";

const [, , host = "127.0.0.1", port = "2222", key, knownHosts, cwd = "/home/pi/work"] = process.argv;

if (key === undefined || knownHosts === undefined) {
    console.error("usage: rpc-check.mjs <host> <port> <key> <known_hosts> [cwd]");
    process.exit(2);
}

const ssh = spawn(
    "ssh",
    [
        "-p",
        port,
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
        `pi@${host}`,
        `cd ${cwd} && exec pi --mode rpc`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
);

const pending = new Map();
const lines = [];
let buffer = "";
let stderr = "";

ssh.stdout.setEncoding("utf8");
ssh.stdout.on("data", (text) => {
    buffer += text;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") {
            lines.push(line);
            let record;
            try {
                record = JSON.parse(line);
            } catch {
                console.error(`rpc: not JSON: ${line}`);
                process.exit(1);
            }
            const wait = pending.get(record.command);
            if (wait !== undefined) {
                pending.delete(record.command);
                wait(record);
            }
        }
        index = buffer.indexOf("\n");
    }
});
ssh.stderr.setEncoding("utf8");
ssh.stderr.on("data", (text) => {
    stderr += text;
});

const failures = [];
function expect(condition, message) {
    if (!condition) failures.push(message);
}

async function call(command, payload, timeoutMs = 20000) {
    const answered = new Promise((resolve) => pending.set(command, resolve));
    ssh.stdin.write(`${JSON.stringify(payload)}\n`);
    const timer = setTimeout(() => {
        pending.delete(command);
        throw new Error(`no response to ${command} within ${timeoutMs}ms`);
    }, timeoutMs);
    try {
        return await answered;
    } finally {
        clearTimeout(timer);
    }
}

try {
    const state = await call("get_state", { type: "get_state" });
    expect(state.success === true, "get_state did not succeed");
    expect(state.data?.model?.id === "mock-echo", `default model is ${JSON.stringify(state.data?.model?.id)}`);
    expect(
        state.data?.model?.provider === "pie-e2e",
        `default provider is ${JSON.stringify(state.data?.model?.provider)}`,
    );
    expect(
        state.data?.thinkingLevel === "low",
        `default thinking level is ${JSON.stringify(state.data?.thinkingLevel)}`,
    );

    const models = await call("get_available_models", {
        type: "get_available_models",
    });
    const ids = (models.data?.models ?? []).map((model) => model.id);
    expect(ids.includes("mock-echo"), `mock-echo missing from ${JSON.stringify(ids)}`);
    expect(ids.includes("mock-alt"), `mock-alt missing from ${JSON.stringify(ids)}`);

    const levels = await call("get_available_thinking_levels", {
        type: "get_available_thinking_levels",
    });
    const available = levels.data?.levels ?? [];
    expect(available.includes("low") && available.includes("high"), `unexpected levels ${JSON.stringify(available)}`);
} catch (error) {
    failures.push(String(error.message ?? error));
} finally {
    ssh.stdin.end();
    ssh.kill("SIGTERM");
}

if (stderr.trim() !== "" && failures.length > 0) {
    console.error(`rpc: stderr: ${stderr.trim()}`);
}
if (failures.length > 0) {
    for (const failure of failures) console.error(`ENV-05/06 FAIL ${failure}`);
    process.exit(1);
}
console.log("ENV-05 PASS get_state, models, thinking levels over pi --mode rpc");
