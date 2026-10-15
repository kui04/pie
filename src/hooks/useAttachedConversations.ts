/**
 * The conversations that the attached sessions hold, by the path of pi's session file.
 *
 * A session never changes its conversation, so the answer of `get_state` for each of them is
 * the match a pick needs: which file a running process already holds. That is one read per
 * attached session, and N is small - Rust may answer the match in one command later.
 *
 * The phase of each session comes from its chart, not from those reads: the chart keeps the
 * phase of its records as they arrive, so a run that continues while the session is off screen
 * still lights the row of the list.
 */

import { useSyncExternalStore } from "react";
import { useQueries } from "@tanstack/react-query";
import type { SessionInfo } from "@/lib/bridge";
import { sessionQueries } from "@/lib/query";
import { phases, subscribeSessions } from "@/lib/sessions";

/** One attached conversation: the session that holds it, and whether that session runs now. */
export interface AttachedConversation {
    session: string;
    working: boolean;
}

export function useAttachedConversations(sessions: readonly SessionInfo[]): ReadonlyMap<string, AttachedConversation> {
    const phaseOfEach = useSyncExternalStore(subscribeSessions, phases, phases);
    const reads = useQueries({ queries: sessions.map((session) => sessionQueries.state(session.id)) });

    const attached = new Map<string, AttachedConversation>();
    reads.forEach((read, index) => {
        const session = sessions[index];
        const file = read.data?.sessionFile ?? null;
        if (session === undefined || file === null) return;
        attached.set(file, { session: session.id, working: phaseOfEach.get(session.id) !== "idle" });
    });
    return attached;
}
