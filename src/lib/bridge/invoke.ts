/**
 * The two thin wrappers every command here goes through: `call` for `invoke`,
 * and `Unsubscribe` for the event bus.
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { asPieError, isPieError } from "./error";
import { log } from "./log";

/** Drops a listener. */
export type Unsubscribe = UnlistenFn;

/** Calls a command, and rejects with a [`PieError`] whatever comes back. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(command, args);
    } catch (thrown) {
        const error = asPieError(thrown);

        // A failure of a command arrives as a named `PieError`, and Rust has
        // already logged it: every command is a span, and a span that returns an
        // error writes that error at `ERROR` (see `src-tauri/src/commands/mod.rs`).
        // What never reached a command - a name that is not registered, an
        // argument that does not fit, a permission that is missing - is the one
        // failure nothing else would ever show.
        if (!isPieError(thrown)) log.warn("a call did not reach a command", { command, reason: error.message });

        throw error;
    }
}
