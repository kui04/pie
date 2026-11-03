// The tauri-driver process. It stays up for every WDIO session; WebKitWebDriver
// and the app are its children and end with it.

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function status() {
    const response = await fetch("http://127.0.0.1:4444/status");
    if (!response.ok) throw new Error(`WebDriver status answered ${response.status}`);
    return response.json();
}

export async function startDriver(env, { logPath } = {}) {
    const child = spawn("tauri-driver", [], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
    });
    let failure;
    child.on("error", (error) => {
        failure = error;
    });
    const forward = (data) => {
        process.stderr.write(data);
        if (logPath !== undefined) appendFileSync(logPath, data);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (failure !== undefined) throw failure;
        if (child.exitCode !== null) {
            throw new Error(`tauri-driver exited with code ${child.exitCode}`);
        }
        try {
            const answer = await status();
            if (answer?.value?.ready === true) return { child };
        } catch {
            // The HTTP server and WebKitWebDriver need a moment to appear.
        }
        await sleep(100);
    }
    stopDriver({ child });
    throw new Error("tauri-driver did not answer on port 4444");
}

export function stopDriver(driver) {
    if (driver?.child?.pid === undefined) return;
    try {
        process.kill(-driver.child.pid, "SIGKILL");
    } catch {
        try {
            driver.child.kill("SIGKILL");
        } catch {
            // The process already ended.
        }
    }
}
