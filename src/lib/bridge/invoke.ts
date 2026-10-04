/**
 * The two thin wrappers every command here goes through: `call` for `invoke`,
 * and `Unsubscribe` for the event bus.
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { asPieError } from "./error";

/** Drops a listener. */
export type Unsubscribe = UnlistenFn;

/** Calls a command, and rejects with a [`PieError`] whatever comes back. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(command, args);
    } catch (thrown) {
        throw asPieError(thrown);
    }
}
