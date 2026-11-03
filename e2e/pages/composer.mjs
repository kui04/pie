// The composer: sending, the run state, the model picker, the thinking level,
// and the provider mark.

import { optionByText } from "./selectors.mjs";

const MODEL = "document.querySelector('#composer-model')";
const THINKING = "document.querySelector('#composer-thinking')";
const SUBMIT = "document.querySelector('#composer-submit')";
const LISTBOX = "!!document.querySelector('[role=listbox]')";

export function createComposer(surface) {
    async function openModelPicker() {
        await surface.click(MODEL);
        await surface.waitFor(LISTBOX, { what: "the model menu" });
    }

    async function openThinkingPicker() {
        await surface.click(THINKING);
        await surface.waitFor(LISTBOX, { what: "the level menu" });
    }

    return {
        async send(text) {
            await surface.fill("#composer-input", text);
            await surface.click(SUBMIT);
        },

        async waitForIdle(timeoutMs = 30_000) {
            await surface.waitFor(`${SUBMIT}?.getAttribute('aria-label') === 'Send'`, {
                what: "the run to finish",
                timeoutMs,
            });
        },

        async submitLabel() {
            return surface.execute(`${SUBMIT}?.getAttribute('aria-label')`);
        },

        async stop() {
            await surface.click(SUBMIT);
        },

        async model() {
            return surface.execute(`${MODEL}.innerText.trim()`);
        },

        async expectModel(name) {
            await surface.waitFor(`${MODEL}.innerText.trim() === ${JSON.stringify(name)}`, {
                what: name,
            });
        },

        async openModelPicker() {
            await openModelPicker();
        },

        async modelOptions() {
            return surface.execute(
                `Array.from(document.querySelectorAll('[role=listbox] [role=option]')).map((e) => e.innerText.trim())`,
            );
        },

        async chooseModel(name) {
            if (!(await surface.execute(LISTBOX))) await openModelPicker();
            await surface.waitFor(`!!(${optionByText(name)})`, { what: `the ${name} option` });
            await surface.execute(`(${optionByText(name)}).click()`);
            await surface.waitFor(`!(${LISTBOX})`, { what: "the model menu closing" });
            await this.expectModel(name);
        },

        async thinking() {
            return surface.execute(`${THINKING}.innerText.trim()`);
        },

        async expectThinking(level) {
            await surface.waitFor(`${THINKING}.innerText.trim() === ${JSON.stringify(level)}`, {
                what: level,
            });
        },

        async openThinkingPicker() {
            await openThinkingPicker();
        },

        async thinkingOptions() {
            return surface.execute(
                `Array.from(document.querySelectorAll('[role=listbox] [role=option]')).map((e) => e.innerText.trim())`,
            );
        },

        async chooseThinking(level) {
            if (!(await surface.execute(LISTBOX))) await openThinkingPicker();
            await surface.waitFor(`!!(${optionByText(level)})`, { what: `the ${level} option` });
            await surface.execute(`(${optionByText(level)}).click()`);
            await surface.waitFor(`!(${LISTBOX})`, { what: "the level menu closing" });
            await this.expectThinking(level);
        },

        async providerMark() {
            return surface.execute(`(() => {
                const mark = document.querySelector('#composer-model [data-provider]');
                return {
                    provider: mark !== null,
                    mask: mark?.style.maskImage ?? null,
                    bot: document.querySelector('#composer-model svg.lucide-bot') !== null,
                };
            })()`);
        },

        async expectProviderMark({ requireDataUrl = false } = {}) {
            await surface.waitFor(
                `!!document.querySelector('#composer-model [data-provider]') || !!document.querySelector('#composer-model svg.lucide-bot')`,
                { what: "the provider mark" },
            );
            const mark = await this.providerMark();
            if (mark.mask !== null && !mark.mask.includes("data:image/svg+xml;base64,")) {
                throw new Error(`the provider mark is not a data url: ${mark.mask}`);
            }
            if (requireDataUrl && !(mark.mask ?? "").includes("data:image/svg+xml;base64,")) {
                throw new Error(`the provider mark is not a data url: ${mark.mask}`);
            }
            if (!mark.provider && !mark.bot) throw new Error("the picker drew no mark for the provider");
            return mark;
        },
    };
}
