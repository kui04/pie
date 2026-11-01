/**
 * The one call every command of this layer goes through.
 *
 * Nothing above this folder touches `invoke` or the event bus itself (see
 * `.agents/rules/architecture.md`).
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { asPieError, isPieError } from "./error";
import { log } from "./log";

/** Drops a listener. */
export type Unsubscribe = UnlistenFn;

/** Calls a command, and rejects with a `PieError` whatever comes back. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(command, args);
    } catch (thrown) {
        const error = asPieError(thrown);

        // A command that ran already logged its own failure. What never reached one
        // - an unregistered name, an argument of the wrong shape, a missing
        // permission - is the only failure nothing else would show.
        if (!isPieError(thrown)) log.warn("a call did not reach a command", { command, reason: error.message });

        throw error;
    }
}
