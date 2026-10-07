/**
 * The workspace's one session: its subscriptions, its snapshot, and the store they
 * both feed.
 *
 * The listener starts first and the snapshot is pulled after it: the event bus has
 * no replay, and Rust sends an event only to a window that already listens, so the
 * other order would lose the records in between.
 *
 * The subscription lives here rather than in a component
 * (`.agents/rules/state.md`).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState } from "react";
import * as bridge from "@/lib/bridge";
import { sessionQueries } from "@/lib/query";
import { useTranscriptStore } from "@/stores/transcript.store";

/**
 * How often the usage of a session is read with no event to say it changed.
 *
 * A run that streams for minutes reports its cost in events of the run, which
 * this query does not see, so the ring of the header asks again after a while.
 */
const STATS_FALLBACK_MS = 30_000;

/**
 * When to ask again for the usage of a session.
 *
 * A read that failed is not asked again: the pi of this connection is gone, the
 * answer would be the same one, and the asking would go on every 30 seconds for
 * as long as the screen stays open.
 */
export function statsRefetchInterval(query: { state: { status: string } }): number | false {
    return query.state.status === "error" ? false : STATS_FALLBACK_MS;
}

export function useSession(session: string) {
    const queryClient = useQueryClient();
    /** The session whose listeners are open, once they are. */
    const [listening, setListening] = useState<string | null>(null);
    /**
     * The failure of opening the listeners of `session`, which no query holds.
     */
    const [failure, setFailure] = useState<{ session: string; error: bridge.PieError } | null>(null);
    /**
     * How many times the listeners of this session have been asked for. That a
     * subscription failed is a state of this hook, which no invalidation reaches.
     */
    const [attempt, setAttempt] = useState(0);
    const appendEntry = useTranscriptStore((state) => state.appendEntry);
    const hydrate = useTranscriptStore((state) => state.hydrate);
    const clear = useTranscriptStore((state) => state.clear);

    // A different session starts from nothing: a consumer reads the store while it
    // renders, so clearing after a passive effect would paint one frame of the last
    // session's entries.
    useLayoutEffect(() => {
        clear();
    }, [session, clear]);

    useEffect(() => {
        let alive = true;
        let off: bridge.Unsubscribe[] = [];

        void (async () => {
            // Half a pair of listeners is worth less than none: a second subscription
            // that fails drops the first one again.
            try {
                const events = await bridge.onSessionEvent(session, (event) => {
                    switch (event.type) {
                        case "entry_appended":
                            appendEntry(event.entry);
                            break;
                        case "session_info_changed":
                            // The name of the session changed; its state is stale.
                            void queryClient.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey });
                            break;
                        case "message_end":
                        case "turn_end":
                            // A run reports its cost while it streams; the usage of
                            // the session changed with it.
                            void queryClient.invalidateQueries({ queryKey: sessionQueries.stats(session).queryKey });
                            break;
                        default:
                            // Everything else belongs to a milestone that shows it:
                            // the queue, the thinking level, the run's own progress.
                            break;
                    }
                });
                off = [events];
                // The cleanup of this effect may have run already, before this
                // listener arrived - it saw an empty list then, so nothing else
                // would ever drop this one.
                if (!alive) {
                    events();
                    return;
                }
                // The pi of this session is gone; the read that follows fails with the
                // reason Rust names.
                const end = await bridge.onSessionState(session, () => {
                    void queryClient.invalidateQueries({ queryKey: ["session", session] });
                });
                off = [events, end];
            } catch (thrown) {
                for (const unsubscribe of off) unsubscribe();
                off = [];
                if (alive) setFailure({ session, error: bridge.asPieError(thrown) });
                return;
            }

            // The effect is gone: nothing stays open, and no read starts.
            if (!alive) {
                for (const unsubscribe of off) unsubscribe();
                return;
            }
            // These listeners are open now, and only now may this session be read. The
            // reads are marked stale first: an answer from before the listeners existed
            // may miss every record in between, and `staleTime` would keep it fresh.
            void queryClient.invalidateQueries({ queryKey: ["session", session] });
            setListening(session);
            // The attempt before this one has nothing to say about the session now open.
            setFailure(null);
        })();

        return () => {
            alive = false;
            for (const unsubscribe of off) unsubscribe();
            off = [];
            // A later read of this session may not be taken on the word of this effect.
            setListening(null);
        };
    }, [session, appendEntry, clear, queryClient, attempt]);

    // The listeners are open, so this session may be read: `enabled` keeps the reads
    // off until then, and the records in between cannot pass unheard.
    const open = listening === session;
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open, refetchInterval: statsRefetchInterval });

    // The snapshot is the authority for the transcript; it is not written from a
    // cache the visit before left behind, which the open gate above prevents.
    useEffect(() => {
        if (open && entries.data) hydrate(entries.data);
    }, [open, entries.data, hydrate]);

    // The transcript a caller wants is the store, not this query: `snapshot` is one
    // read, while the store also holds what the events appended since.
    //
    // `reopen` asks for the listeners again, for a screen whose failure is the
    // subscription itself.
    return {
        state,
        snapshot: entries,
        stats,
        listening: open,
        error: failure?.session === session ? failure.error : null,
        reopen: () => setAttempt((times) => times + 1),
    };
}
