/**
 * What pi answers about a session, on request.
 *
 * These are the reads of the workspace: the state of a session, its transcript,
 * and its usage. Each names its session by the id that `connect` answered with
 * (`ConnectionInfo.sessions[].id`), which is the id its events arrive under.
 *
 * `get_entries` answers with the raw set of entries: the other branches of a
 * fork are in it, and the entries that a compaction summarized stay in it. The
 * view of the transcript is built from it on this side (see
 * `stores/transcript.store.ts`).
 */

import type { EntriesData, SessionState, SessionStats } from "@/lib/protocol";
import { call } from "./invoke";

/** The state of one session. */
export function getState(session: string): Promise<SessionState> {
    return call<SessionState>("get_state", { session });
}

/** Every entry of one session, and the leaf it points at. */
export function getEntries(session: string): Promise<EntriesData> {
    return call<EntriesData>("get_entries", { session });
}

/** The usage of one session: its counts, its tokens, its cost, its context. */
export function getSessionStats(session: string): Promise<SessionStats> {
    return call<SessionStats>("get_session_stats", { session });
}
