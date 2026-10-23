/**
 * The one signal that a read failed, which is the earliest news that the reach
 * to the machine may have ended.
 *
 * Every read that fails passes through the query cache's own `onError`
 * (`lib/query/index.ts`), which is the only place that sees all of them. This
 * module is what turns that into something the boundary can hear, without the
 * cache having to know a React tree exists.
 *
 * A failed read is not proof that the reach ended: a pi that exited behind a live
 * reach fails a session read exactly the way a dead transport does. Therefore the
 * signal carries no verdict - the boundary asks Rust what the reach is doing and
 * lets the answer decide. What the signal buys is the moment: without it the
 * window waits for the watch's next tick, and the first failure is already news.
 */

/**
 * Whether a failed read is one whose failure can carry news of the reach.
 *
 * Every read the app files is a question to Rust about the machine, except the
 * connection read itself: its failure is a broken IPC, and asking whether the
 * reach is open again would only repeat the question that just failed.
 */
export function isReachRead(queryKey: readonly unknown[]): boolean {
    return queryKey[0] !== "connection";
}

/** The listeners that want to hear about a failure against the reach. */
const listeners = new Set<() => void>();

/** Hears about every read that failed against the reach, until the returned function is called. */
export function subscribeToReachFailures(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Says that a read failed against the reach. Called where every failed read passes. */
export function reportReachFailure(): void {
    for (const listener of listeners) listener();
}
