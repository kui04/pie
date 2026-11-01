/**
 * The ask channel: a question Rust puts to the frontend and waits on.
 *
 * The mirror of `src-tauri/src/bus.rs`. Rust keeps every ask it waits on with what
 * is left of its budget, so {@link readyForAnswer} replays a question that arrived
 * before the webview listened. An ask that is never answered fails on the waiting
 * side when its budget runs out.
 */

import { listen } from "@tauri-apps/api/event";
import { type Unsubscribe } from "./invoke";

/** Each channel Rust asks on. The payload of each is declared in its area. */
export type AskChannel = "pi://ask/extension" | "pi://ask/host_key";

/** One ask on the wire, with what is left of the time its asker waits. */
export interface AskEnvelope<P> {
    /** Names the waiting ask. {@link ../app.answer} takes it back. */
    id: number;
    /** Milliseconds left to show a countdown against. */
    timeoutMs: number;
    payload: P;
}

/** What the frontend answers. */
export type Answer = { status: "resolved"; data: unknown } | { status: "rejected"; data: string };

/** Listens to one ask channel until the returned function is called. */
export function onAsk<P>(channel: AskChannel, onRequest: (envelope: AskEnvelope<P>) => void): Promise<Unsubscribe> {
    return listen<AskEnvelope<P>>(channel, (event) => onRequest(event.payload));
}
