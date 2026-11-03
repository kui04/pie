// The transcript and its run states: streaming text, the working ring, the
// connection-lost alert, and the extension prompt.

import { buttonByText, textIncludes } from "./selectors.mjs";

const WORKING_RING = "document.querySelector('[aria-label=\"Working\"]')";
const LOST_OVERLAY = `Array.from(document.querySelectorAll('[role=alertdialog]')).find((e) => e.innerText.includes('The connection to'))`;

export function createSession(surface) {
    return {
        async text() {
            return surface.text();
        },

        async waitForComposer() {
            await surface.waitFor("!!document.querySelector('#composer-input')", { what: "the composer" });
        },

        async expectText(part, { timeoutMs = 20_000 } = {}) {
            await surface.waitFor(textIncludes(part), {
                what: `the text ${JSON.stringify(part)}`,
                timeoutMs,
            });
        },

        async expectTextCount(part, count, { timeoutMs = 25_000 } = {}) {
            await surface.waitFor(`document.body.innerText.split(${JSON.stringify(part)}).length - 1 >= ${count}`, {
                what: `${count} copies of ${JSON.stringify(part)}`,
                timeoutMs,
            });
        },

        async expectWorkingRing() {
            await surface.waitFor(`!!${WORKING_RING}`, { what: "the working ring" });
        },

        async workingRingTransform() {
            return surface.execute(
                `(() => { const e = ${WORKING_RING}?.parentElement; return e ? getComputedStyle(e).transform : null; })()`,
            );
        },

        async expectConnectionLost(address, { timeoutMs = 15_000 } = {}) {
            await surface.waitFor(`!!(${LOST_OVERLAY})`, {
                what: "the connection lost overlay",
                timeoutMs,
            });
            const text = await surface.execute(`(${LOST_OVERLAY}).innerText`);
            if (!text.includes(address)) throw new Error(`the overlay is ${JSON.stringify(text)}`);
            return text;
        },

        async reconnect() {
            await surface.execute(
                `Array.from(document.querySelectorAll('[role=alertdialog] button')).find((b) => b.innerText.trim() === 'Reconnect').click()`,
            );
            await surface.waitFor(`!(${LOST_OVERLAY})`, {
                what: "the overlay leaving",
                timeoutMs: 25_000,
            });
        },

        async expectExtensionPrompt({ timeoutMs = 25_000 } = {}) {
            await surface.waitFor("!!document.querySelector('#extension-select-row-0')", {
                what: "the ask_user prompt",
                timeoutMs,
            });
        },

        async extensionDialogText(question) {
            return surface.execute(
                `Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog]')).find((e) => e.innerText.includes(${JSON.stringify(question)}))?.innerText ?? null`,
            );
        },

        async chooseExtensionRow(index) {
            await surface.click(`document.querySelector('#extension-select-row-${index}')`);
        },

        async confirmExtension() {
            await surface.click(buttonByText("Confirm"));
        },
    };
}
