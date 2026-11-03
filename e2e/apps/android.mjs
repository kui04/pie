// The Android adapter: adb and the WebView DevTools protocol own the device,
// this file owns the app lifecycle around them.

import { execFileSync } from "node:child_process";
import { APP_ID, Cdp, launch } from "../runners/android/cdp.mjs";
import { createApp } from "./app.mjs";

export function createAndroidApp(cdp, context, { serial, port }) {
    let current = cdp;
    const surface = {
        execute: (expression) => current.eval(expression),
        text: () => current.text(),
        waitFor: (expression, options) => current.waitFor(expression, options),
        click: (expression, options) => current.click(expression, options),
        fill: (selector, value) => current.fill(selector, value),
        screenshot: (path) => current.screenshot(path),
    };

    return createApp({
        surface,
        context,
        async restart() {
            current.close();
            launch(serial);
            current = await Cdp.find(serial, port);
        },
        close: async () => current.close(),
        diagnostics: {
            log() {
                return execFileSync("adb", ["-s", serial, "logcat", "-d", "-t", "4000"], { encoding: "utf8" });
            },
            appDataContains(text) {
                let output;
                try {
                    output = execFileSync(
                        "adb",
                        ["-s", serial, "shell", "run-as", APP_ID, "grep", "-rl", text, `/data/data/${APP_ID}`],
                        { encoding: "utf8" },
                    );
                } catch (error) {
                    output = String(error.stdout ?? "");
                }
                return output.includes(text);
            },
        },
    });
}
