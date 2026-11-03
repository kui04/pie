// The Linux adapter: WebdriverIO owns the session and the browser commands.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.mjs";

export class WebdriverPage {
    constructor(browser) {
        this.browser = browser;
    }

    async execute(expression, timeoutMs = 20_000) {
        return this.browser.execute(`return (${expression});`, {
            timeout: timeoutMs,
        });
    }

    async text() {
        return this.execute("document.body.innerText");
    }

    async waitFor(expression, { what = expression, timeoutMs = 15_000 } = {}) {
        await this.browser.waitUntil(
            async () => {
                try {
                    return Boolean(await this.execute(expression));
                } catch {
                    return false;
                }
            },
            {
                timeout: timeoutMs,
                interval: 150,
                timeoutMsg: `timed out waiting for ${what}`,
            },
        );
    }

    async click(expression, { what = expression, timeoutMs = 15_000 } = {}) {
        await this.waitFor(expression, { what, timeoutMs });
        await this.execute(`(${expression}).click()`);
    }

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
        await this.browser.saveScreenshot(path);
    }

    /** Stops the app and starts it again on the same XDG data. */
    async restart() {
        process.env.PIE_E2E_PRESERVE_DATA = "1";
        await this.browser.reloadSession();
        await this.browser.setWindowSize(800, 600);
    }
}

export function createLinuxApp(browser, context) {
    const surface = new WebdriverPage(browser);
    return createApp({
        surface,
        context,
        restart: () => surface.restart(),
        close: async () => {},
        diagnostics: {
            log() {
                return readFileSync(join(context.artifacts, "driver.log"), "utf8");
            },
            appDataContains(text) {
                const roots = [
                    process.env.HOME,
                    process.env.XDG_DATA_HOME,
                    process.env.XDG_CONFIG_HOME,
                    process.env.XDG_CACHE_HOME,
                ].filter((root) => root !== undefined);
                if (roots.length === 0) return false;
                try {
                    const output = execFileSync("grep", ["-rl", "--", text, ...roots], { encoding: "utf8" });
                    return output.includes(text);
                } catch (error) {
                    return String(error.stdout ?? "").includes(text);
                }
            },
        },
    });
}
