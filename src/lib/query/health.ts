/**
 * The one signal that a read failed against the reach to the machine.
 *
 * Every read that fails passes through the query cache's own `onError` (`lib/query/index.ts`), which
 * is the only place that sees all of them. This module is what turns that into something the
 * boundary can hear, without the cache having to know a React tree exists.
 *
 * A failed read is not proof that the reach ended: a pi that exited behind a live reach fails a
 * session read exactly the way a dead transport does. Therefore the signal carries no verdict -
 * the boundary asks Rust what the reach is doing and lets the answer decide. What the signal
 * buys is the moment: without it the window waits for the watch's next tick, and the first
 * failure is already news.
 */

import type { PieErrorModule } from "@/lib/bridge/error";

/**
 * The modules of a failure that can carry a lost reach to the machine.
 *
 * `rpc` is in this list because that is how a dead transport arrives: the client is closed, and
 * every session read then fails as `closed: transport closed` - the same shape a pi that exited
 * behind a live reach leaves. The two are not distinguishable here, and they do not have to be:
 * this list only says which failure is worth asking Rust about, and Rust answers with `open`.
 */
const REACH: readonly PieErrorModule[] = ["channel", "host", "rpc"];

/** The listeners that want to hear about a failure against the reach. */
const listeners = new Set<() => void>();

/** Whether this failure is one of the reach to the machine. */
export function isReachFailure(thrown: unknown): boolean {
    if (typeof thrown !== "object" || thrown === null) return false;
    const type = (thrown as { type?: unknown }).type;
    return typeof type === "string" && (REACH as readonly string[]).includes(type);
}

/** Hears about every read that failed against the reach, until the returned function is called. */
export function subscribeToReachFailures(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Says that a read failed against the reach. Called where every failed read passes. */
export function reportReachFailure(): void {
    for (const listener of listeners) listener();
}
