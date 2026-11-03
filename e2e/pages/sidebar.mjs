// The session drawer: the project group, its rows, a new conversation, and the
// delete flow. Every selector stays here.

import { buttonByText, rowByText, textIncludes } from "./selectors.mjs";

const DRAWER = "document.querySelector('#session-sheet-drawer')";
const ROWS = "[id^=session-sheet-drawer-row-]";
const REFRESH = "document.querySelector('#session-sheet-drawer-refresh')";

export function createSidebar(surface) {
    async function open() {
        if (!(await surface.execute(`!!${DRAWER}`))) {
            await surface.click("document.querySelector('#sidebar_toggle')");
        }
        await surface.waitFor(`!!document.querySelector(${JSON.stringify(ROWS)})`, {
            what: "the session rows",
            timeoutMs: 30_000,
        });
    }

    async function waitForRow(text) {
        await surface.waitFor(`!!(${rowByText(text)})`, {
            what: `the ${text} row`,
            timeoutMs: 30_000,
        });
    }

    async function refresh() {
        if (await surface.execute(`!!${REFRESH}`)) await surface.click(REFRESH);
    }

    return {
        open,
        waitForRow,
        refresh,

        async expectProject(name) {
            await surface.waitFor(textIncludes(name), { what: `the project ${name}`, timeoutMs: 15_000 });
        },

        async rows() {
            return surface.execute(
                `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)})).map((e) => e.innerText.trim().replace(/\\n/g, '|'))`,
            );
        },

        async openSession(text) {
            await open();
            await waitForRow(text);
            await surface.execute(`(${rowByText(text)}).click()`);
            await surface.waitFor("!!document.querySelector('#composer-input')", {
                what: `the ${text} transcript`,
            });
        },

        async newSession(directory) {
            await surface.click("document.querySelector('#session-sheet-drawer-new')");
            await surface.waitFor("!!document.querySelector('#directory-picker-scroll')", {
                what: "the folder picker",
            });
            await surface.fill("#directory-picker-field", directory);
            await surface.waitFor(
                `document.querySelector('#directory-picker-field')?.value === ${JSON.stringify(directory)}`,
                { what: "the chosen folder" },
            );
            await surface.waitFor(`!(${buttonByText("Open")}).disabled`, { what: "an enabled Open" });
            await surface.execute(`(${buttonByText("Open")}).click()`);
            await surface.waitFor("!document.querySelector('#directory-picker-scroll')", {
                what: "the picker closing",
            });
            await surface.waitFor("!!document.querySelector('#composer-input')", {
                what: "the empty conversation",
            });
        },

        async deleteSession(text) {
            await open();
            await refresh();
            await waitForRow(text);
            const row = await surface.execute(`(${rowByText(text)}).id`);
            const menu = `document.querySelector('#${row.replace(/^session-sheet-drawer-row-/, "session-sheet-drawer-menu-")}')`;
            await surface.click(menu);
            await surface.click("document.querySelector('[id$=-delete]')");
            await surface.waitFor(textIncludes("Delete this conversation?"), {
                what: "the delete question",
            });
            const confirm = `Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog]'))
                .filter((e) => e.innerText.includes('Delete this conversation'))
                .flatMap((e) => Array.from(e.querySelectorAll('button')))
                .find((b) => b.innerText.trim() === 'Delete')`;
            await surface.execute(`(${confirm}).click()`);
            await surface.waitFor(`!(${rowByText(text)})`, { what: "the row leaving" });
        },
    };
}
