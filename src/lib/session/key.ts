/**
 * The name of one conversation.
 *
 * A conversation is a file on a machine, and two machines can hold the same path,
 * so the name is a pair. Every cache, registry and listener keys on this pair, never
 * on the path alone.
 */

import type { HostId } from "@/lib/bridge";

/** One conversation of one machine. */
export interface SessionKey {
    /** The connection that serves it. */
    host: HostId;
    /** The conversation file on that machine. */
    session: string;
}

/** Whether an event that names a `host` and a `session` belongs to this conversation. */
export function isOf(key: SessionKey, event: { host: HostId; session: string }): boolean {
    return event.host === key.host && event.session === key.session;
}

/**
 * One string for a map or a subscriber set.
 *
 * A path cannot contain a null byte, so the joined text names one pair exactly.
 */
export function idOf(key: SessionKey): string {
    return `${key.host}\u0000${key.session}`;
}
