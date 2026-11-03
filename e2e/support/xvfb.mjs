// A private X display for WebKitGTK. A killed Xvfb can leave its lock file
// behind; remove only the lock whose process is gone.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function displayInUse(number) {
    const lock = `/tmp/.X${number}-lock`;
    if (!existsSync(lock)) return false;
    try {
        const pid = Number(readFileSync(lock, "utf8").trim());
        if (pid > 0) {
            process.kill(pid, 0);
            return true;
        }
    } catch {
        // The owner is gone; the lock is stale.
    }
    try {
        rmSync(lock);
    } catch {
        return true;
    }
    return false;
}

export async function startXvfb() {
    for (let number = 90; number < 120; number += 1) {
        if (displayInUse(number)) continue;
        const display = `:${number}`;
        const child = spawn("Xvfb", [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: "ignore" });
        await sleep(300);
        if (child.exitCode === null) return { child, display };
    }
    throw new Error("could not start Xvfb");
}

export async function stopXvfb(xvfb) {
    if (xvfb?.child === undefined) return;
    xvfb.child.kill("SIGTERM");
    await sleep(300);
    if (xvfb.child.exitCode === null) xvfb.child.kill("SIGKILL");
}
