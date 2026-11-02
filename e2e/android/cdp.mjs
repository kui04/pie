// A small Chrome DevTools Protocol client for the Android WebView of a debug
// build. It needs no npm package: Node has WebSocket and fetch, and adb
// forwards the devtools socket of the app process.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP_ID = "me.kui04.pie";

export function adb(serial, args, options = {}) {
  return execFileSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

export function launch(serial) {
  adb(serial, ["shell", "am", "force-stop", APP_ID]);
  adb(serial, ["shell", "am", "start", "-n", `${APP_ID}/.MainActivity`]);
}

export function stop(serial) {
  adb(serial, ["shell", "am", "force-stop", APP_ID]);
}

export function clear(serial) {
  adb(serial, ["shell", "pm", "clear", APP_ID]);
}

/** The abstract devtools socket of the running app, or undefined. */
function devtoolsSocket(serial) {
  const table = adb(serial, ["shell", "cat", "/proc/net/unix"]);
  const names = [...table.matchAll(/webview_devtools_remote_(\d+)/g)].map(
    (match) => match[1],
  );
  return names.length === 0
    ? undefined
    : `localabstract:webview_devtools_remote_${names.at(-1)}`;
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok)
    throw new Error(`devtools list answered ${response.status}`);
  return response.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("close", () => {
      for (const waiting of this.pending.values())
        waiting.reject(new Error("the devtools socket closed"));
      this.pending.clear();
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined)
        waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    });
  }

  static async find(serial, port) {
    // A relaunched app gets a new pid and a new devtools socket. The socket
    // name is read again on every attempt; a cached name would point at the
    // page that just went away.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const socket = devtoolsSocket(serial);
      if (socket !== undefined) {
        try {
          adb(serial, ["forward", `tcp:${port}`, socket]);
          const list = await targets(port);
          const page = list.find((target) => target.type === "page");
          if (page !== undefined) {
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            const opened = await Promise.race([
              new Promise((resolve) => {
                ws.addEventListener("open", () => resolve(true), {
                  once: true,
                });
                ws.addEventListener("error", () => resolve(false), {
                  once: true,
                });
              }),
              sleep(3000).then(() => false),
            ]);
            if (!opened) {
              ws.close();
            } else {
              const cdp = new Cdp(ws);
              try {
                await cdp.send("Runtime.enable", {}, 5000);
                await cdp.send("Page.enable", {}, 5000);
                return cdp;
              } catch {
                ws.close();
              }
            }
          }
        } catch {
          // The socket or the forward appears a moment after the window.
        }
      }
      await sleep(250);
    }
    throw new Error("no answer from the devtools socket of the app");
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression in the page and returns its value. */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(`page threw: ${text}`);
    }
    return result.result?.value;
  }

  async text() {
    return this.eval("document.body.innerText");
  }

  async waitFor(expression, { timeoutMs = 15000, what = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval(`!!(${expression})`)) return;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async click(expression, { what = expression, timeoutMs = 15000 } = {}) {
    await this.waitFor(expression, { what, timeoutMs });
    await this.eval(`(${expression}).click()`);
  }

  /** Types into a React-controlled field through its own value setter. */
  async fill(selector, value) {
    const result = await this.eval(`(() => {
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
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(result.data, "base64"));
  }

  close() {
    this.socket.close();
  }
}

/** Launches the app and waits for the page target of its WebView. */
export async function connect(serial, { port = 9333, artifacts } = {}) {
  launch(serial);
  const cdp = await Cdp.find(serial, port);
  if (artifacts !== undefined) {
    const dir = join(artifacts, "screens");
    mkdirSync(dir, { recursive: true });
    cdp.screens = dir;
  }
  return cdp;
}

export { APP_ID };
