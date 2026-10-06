/**
 * What pi says about a running session, as it says it.
 *
 * One subscription per channel, under the id of the session. The events of a
 * session arrive on `pi://session/{id}/event`, and its end arrives on
 * `pi://session/{id}/state`.
 *
 * Two kinds of record of a session never arrive here: a dialog of an extension
 * and a failure of an extension have channels of their own, and nothing consumes
 * them yet (they belong to the extension milestone). A record that Rust cannot
 * describe is not forwarded at all.
 *
 * A listener must exist before the records it wants: the event bus has no
 * replay, and Rust sends an event only to a window that already listens for its
 * name. Therefore a caller subscribes first and reads afterwards (see
 * `hooks/use-session.ts`), which is what makes a missed record a record that the
 * snapshot covers.
 */

import { listen } from "@tauri-apps/api/event";
import type { Event } from "@/lib/protocol";
import type { Unsubscribe } from "./invoke";

/** How the pi of a session ended. */
export type Termination =
    { type: "exited"; code: number; success: boolean } | { type: "signalled"; signal: number } | { type: "unknown" };

/**
 * What the frontend hears about the life of a session.
 *
 * Rust owns this shape (`commands/pipe.rs` there), so it is written here by
 * hand, like every other type of the app's own commands.
 */
export type SessionLifecycle = {
    type: "ended";
    /** How the process ended; `success` separates an orderly end from a crash. */
    termination: Termination;
};

/** One event of a session. */
export function onSessionEvent(session: string, onEvent: (event: Event) => void): Promise<Unsubscribe> {
    return listen<Event>(`pi://session/${session}/event`, (event) => onEvent(event.payload));
}

/** The end of a session. No record of that session follows. */
export function onSessionState(session: string, onState: (state: SessionLifecycle) => void): Promise<Unsubscribe> {
    return listen<SessionLifecycle>(`pi://session/${session}/state`, (event) => onState(event.payload));
}
