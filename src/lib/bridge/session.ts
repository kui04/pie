/**
 * A session of pi: the sessions of the host, what one holds, and what it says while
 * it runs.
 *
 * A session is named by the id that `connect` answered with
 * (`ConnectionInfo.sessions[].id`) — pie's id for the process, which is the id its
 * events arrive under. That is not the id of pi's session file: the same process
 * moves between those (see `switchSession`).
 *
 * A dialog of an extension and a failure of an extension have channels of their own,
 * and nothing consumes them yet (that belongs to the extension milestone). A record
 * that Rust cannot describe is not forwarded at all.
 *
 * A listener must exist before the records it wants: the event bus has no replay, and
 * Rust sends an event only to a window that already listens for its name. Therefore a
 * caller subscribes first and reads afterwards (see `hooks/use-session.ts`), which is
 * what makes a missed record a record that the snapshot covers.
 *
 * The types here are hand-written mirrors: `SessionSummary` of
 * `connection::SessionSummary`, the lifecycle of `commands/pipe.rs`, and the payloads
 * of the commands below of `commands/session.rs` — except `listSessions`, whose rows
 * are assembled in `commands/files.rs`. Rust is the authority.
 */

import { listen } from "@tauri-apps/api/event";
import type { EntriesData, Event, SessionState, SessionStats, SwitchSessionData } from "@/lib/protocol";
import { call, type Unsubscribe } from "./invoke";

// The sessions of the host. These are files, not protocol: pie scans the sessions
// directory itself, on this machine or over sftp, because pi has no command that
// lists its sessions.

/** One session that pi wrote, as its own lines report it. */
export interface SessionSummary {
    /** The place of the file, as the host sees it. */
    path: string;
    /** The id of the session from pi, from the header of the file. */
    id: string;
    /** Where the session started. Empty for files that are older than this field of pi. */
    cwd: string;
    /** The display name that the user gave last, if present. */
    name?: string | null;
    /** The session of the fork, if this session is a fork. */
    parentSessionPath?: string | null;
    /** The start time of the session by pi, RFC3339. */
    created: string;
    /** The time of the last growth of the file, RFC3339. */
    modified: string;
    /** The first words of the user, if the file goes that far. */
    firstMessage?: string | null;
}

/**
 * Every session on the connected host, most recently written first.
 *
 * A session that has said nothing yet has no file, and therefore no row: pi
 * writes one at the start of the first turn (its `#10000` rule).
 */
export function listSessions(): Promise<SessionSummary[]> {
    return call<SessionSummary[]>("list_sessions");
}

// One session, by the name of it.

/**
 * The state of one session: its model, its run, its name, its counts.
 *
 * `sessionId` here is the id of pi's session file, which is what tells one
 * conversation of a process from another (see `switchSession`).
 */
export function getState(session: string): Promise<SessionState> {
    return call<SessionState>("get_state", { session });
}

/**
 * Every entry of one session, and the leaf it points at.
 *
 * The answer is the raw set: the other branches of a fork are in it, and the
 * entries that a compaction summarized stay in it. The view of the transcript is
 * built from it on this side (see `stores/transcript.store.ts`).
 */
export function getEntries(session: string): Promise<EntriesData> {
    return call<EntriesData>("get_entries", { session });
}

/** The usage of one session: its counts, its tokens, its cost, its context. */
export function getSessionStats(session: string): Promise<SessionStats> {
    return call<SessionStats>("get_session_stats", { session });
}

/**
 * Makes a session continue the conversation of a session file.
 *
 * `path` is the `path` of a row that {@link listSessions} answered with (the
 * frontend builds none of them: pi opens a path that holds no file as a new
 * conversation in its own directory). The pi process keeps running; the
 * conversation it holds does not. No event announces the change, so the caller
 * reads the transcript again — `cancelled` says that an extension of pi refused
 * the switch, and then nothing changed at all.
 */
export function switchSession(session: string, path: string): Promise<SwitchSessionData> {
    return call<SwitchSessionData>("switch_session", { session, path });
}

// What pi says about a running session, as it says it.

/** How the pi of a session ended. */
export type Termination =
    { type: "exited"; code: number; success: boolean } | { type: "signalled"; signal: number } | { type: "unknown" };

/** What the frontend hears about the life of a session. */
export type SessionLifecycle = {
    type: "ended";
    /** How the process ended; `success` separates an orderly end from a crash. */
    termination: Termination;
};

/** One event of a session, on `pi://session/{id}/event`. */
export function onSessionEvent(session: string, onEvent: (event: Event) => void): Promise<Unsubscribe> {
    return listen<Event>(`pi://session/${session}/event`, (event) => onEvent(event.payload));
}

/** The end of a session. No record of that session follows. */
export function onSessionState(session: string, onState: (state: SessionLifecycle) => void): Promise<Unsubscribe> {
    return listen<SessionLifecycle>(`pi://session/${session}/state`, (event) => onState(event.payload));
}
