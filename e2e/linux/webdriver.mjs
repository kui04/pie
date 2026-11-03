// A small W3C WebDriver client for the Linux desktop app. `tauri-driver` starts
// WebKitWebDriver and the Tauri binary; every case gets one app session.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BASE = "http://127.0.0.1:4444";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(BASE + path, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
    const answer = await response.json().catch(() => null);
    const value =
      answer !== null &&
      typeof answer === "object" &&
      Object.hasOwn(answer, "value")
        ? answer.value
        : answer;
    if (
      !response.ok ||
      (value !== null && typeof value === "object" && value.error !== undefined)
    ) {
      throw new Error(
        value?.message ?? `WebDriver answered ${response.status}`,
      );
    }
    return value;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `WebDriver did not answer ${path} within ${timeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Starts the proxy and waits until it accepts a session. */
export async function startDriver(env) {
  const child = spawn("tauri-driver", [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let failure;
  child.on("error", (error) => {
    failure = error;
  });
  child.stdout.on("data", (data) => process.stderr.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    if (child.exitCode !== null) {
      throw new Error(`tauri-driver exited with code ${child.exitCode}`);
    }
    try {
      const status = await call("/status", { timeoutMs: 1000 });
      if (status?.ready === true) return { child };
    } catch {
      // The HTTP server and WebKitWebDriver need a moment to appear.
    }
    await sleep(100);
  }
  stopDriver({ child });
  throw new Error("tauri-driver did not answer on port 4444");
}

/** Ends the proxy and every child it owns, including WebKitWebDriver. */
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

/** One launched Tauri window and the page inside it. */
export class AppSession {
  constructor(id) {
    this.id = id;
    this.closed = false;
  }

  static async open(application) {
    const answer = await call("/session", {
      method: "POST",
      body: {
        capabilities: {
          alwaysMatch: {
            browserName: "wry",
            "tauri:options": { application },
          },
        },
      },
      timeoutMs: 60_000,
    });
    if (typeof answer?.sessionId !== "string") {
      throw new Error("WebDriver created no session");
    }
    const session = new AppSession(answer.sessionId);
    // The configured window is 800x600. WebKitWebDriver starts the app at the
    // screen size instead, and the screen is the wide layout at 1280.
    await call(`/session/${session.id}/window/rect`, {
      method: "POST",
      body: { width: 800, height: 600, x: 0, y: 0 },
      timeoutMs: 10_000,
    });
    return session;
  }

  async execute(expression, timeoutMs = 20_000) {
    if (this.closed) throw new Error("the app session is closed");
    return call(`/session/${this.id}/execute/sync`, {
      method: "POST",
      body: { script: `return (${expression});`, args: [] },
      timeoutMs,
    });
  }

  async text() {
    return this.execute("document.body.innerText");
  }

  async waitFor(expression, { what = expression, timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    for (;;) {
      try {
        if (await this.execute(expression)) return;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) {
        const detail = lastError === undefined ? "" : `: ${lastError.message}`;
        throw new Error(`timed out waiting for ${what}${detail}`);
      }
      await sleep(150);
    }
  }

  async click(expression, { what = expression, timeoutMs = 15_000 } = {}) {
    await this.waitFor(expression, { what, timeoutMs });
    await this.execute(`(${expression}).click()`);
  }

  /** Types into a React-controlled field through its own value setter. */
  async fill(selector, value) {
    const result = await this.execute(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) return false;
      const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (result !== true) throw new Error(`no field ${selector}`);
  }

  async screenshot(path) {
    const data = await call(`/session/${this.id}/screenshot`, {
      timeoutMs: 10_000,
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
  }

  async quit() {
    if (this.closed) return;
    this.closed = true;
    try {
      await call(`/session/${this.id}`, { method: "DELETE", timeoutMs: 5_000 });
    } catch {
      // The window can be gone already; the driver cleanup still runs.
    }
  }
}
