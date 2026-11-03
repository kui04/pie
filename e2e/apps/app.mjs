// The platform-neutral app a case receives. A case calls pages; an adapter
// supplies the surface, the restart, the screenshot, and the diagnostics.

import { createPages } from "../pages/index.mjs";

/**
 * @typedef {object} E2ESurface
 * @property {(expression: string) => Promise<any>} execute
 * @property {() => Promise<string>} text
 * @property {(expression: string, options?: { what?: string, timeoutMs?: number }) => Promise<void>} waitFor
 * @property {(expression: string, options?: { what?: string, timeoutMs?: number }) => Promise<void>} click
 * @property {(selector: string, value: string) => Promise<void>} fill
 * @property {(path: string) => Promise<void>} screenshot
 */

/**
 * @typedef {object} E2EHost
 * @property {(script: string, timeoutMs?: number) => string} run
 * @property {(...args: string[]) => string} [compose]
 * @property {() => string[]} sessionFiles
 * @property {(path: string) => number} lineCount
 * @property {() => string} helloFile
 */

/**
 * @typedef {object} E2EContext
 * @property {"android" | "linux"} platform
 * @property {"mock" | "real"} profile
 * @property {string} address
 * @property {string} password
 * @property {string} fingerprint
 * @property {{ privateKey: string, passphraseKey: string, passphrase: string }} [keys]
 * @property {E2EHost} host
 * @property {string} artifacts
 * @property {number} [serial]
 * @property {(ms: number) => Promise<void>} sleep
 * @property {{ id: string, name: string, priority: string }} case
 */

/**
 * @typedef {object} E2EApp
 * @property {object} gate
 * @property {object} sidebar
 * @property {object} session
 * @property {object} composer
 * @property {() => Promise<void>} restart
 * @property {() => Promise<void>} close
 * @property {(path: string) => Promise<void>} screenshot
 * @property {{ log: () => string, appDataContains: (text: string) => boolean }} diagnostics
 */

/**
 * @param {object} options
 * @param {E2ESurface} options.surface
 * @param {E2EContext} options.context
 * @param {() => Promise<void>} options.restart
 * @param {() => Promise<void>} options.close
 * @param {E2EApp["diagnostics"]} options.diagnostics
 * @returns {E2EApp}
 */
export function createApp({ surface, context, restart, close, diagnostics }) {
    return {
        ...createPages(surface, context),
        restart,
        close,
        diagnostics,
        screenshot: (path) => surface.screenshot(path),
    };
}
