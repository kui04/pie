/**
 * The workspace's one session: its subscriptions, its snapshot, and the store
 * they both feed.
 *
 * The order matters and this hook is where it is kept. The listener starts
 * first; the snapshot is pulled after it, and a record that arrived before the
 * snapshot is in the snapshot too (`get_entries` is the authority). The event
 * bus has no replay and Rust sends an event only to a window that already
 * listens, so the other order would lose the records in between.
 *
 * The subscription lives here and not in a component: a component renders state
 * and calls the bridge, it never listens to the bus itself
 * (`.agents/rules/state.md`).
 *
 * A session read fails with a named `PieError`, so a caller shows the reason the
 * query carries; nothing here has words for a person.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState } from "react";
import * as bridge from "@/lib/bridge";
import { sessionQueries } from "@/lib/query";
import { useTranscriptStore } from "@/stores/transcript.store";

export function useSession(session: string) {
    const queryClient = useQueryClient();
    /** The session whose listeners are open, once they are. */
    const [listening, setListening] = useState<string | null>(null);
    /**
     * The session whose listeners could not be opened, and why.
     *
     * The session travels beside the failure so that a new session shows none
     * of it: the answer is a fact about one session, and a hook whose session
     * changed has no failure to report yet.
     */
    const [failure, setFailure] = useState<{ session: string; error: bridge.PieError } | null>(null);
    const appendEntry = useTranscriptStore((state) => state.appendEntry);
    const hydrate = useTranscriptStore((state) => state.hydrate);
    const clear = useTranscriptStore((state) => state.clear);

    // A different session starts from nothing: entries of the last one must not
    // stand in for the entries of this one while its snapshot arrives. This runs
    // before the browser paints, and not in the effect below: a consumer reads
    // the store while it renders, so a clear that waited for a passive effect
    // would paint the entries of the session before this one for one frame.
    useLayoutEffect(() => {
        clear();
    }, [session, clear]);

    useEffect(() => {
        let alive = true;
        let off: bridge.Unsubscribe[] = [];

        void (async () => {
            // Both listeners are opened inside the try, as the handshake of the
            // connect machine opens its own: a listener that does not arrive is
            // a session that cannot be read, and half a pair is worth less than
            // none. What did arrive is dropped again, so a failed second
            // subscription does not leave the first one listening.
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
                const end = await bridge.onSessionState(session, () => {
                    // The pi of this session is gone. Whatever a screen shows is a
                    // read away from the truth, and that read now fails with the
                    // reason Rust names.
                    void queryClient.invalidateQueries({ queryKey: ["session", session] });
                });
                off = [events, end];
            } catch (thrown) {
                for (const unsubscribe of off) unsubscribe();
                off = [];
                if (alive) setFailure({ session, error: bridge.asPieError(thrown) });
                return;
            }

            // The effect is gone. Nothing may stay open, and no read starts.
            if (!alive) {
                for (const unsubscribe of off) unsubscribe();
                return;
            }
            // These listeners are open now, and only now may this session be read.
            // The reads of a session whose cache is still warm are asked again: an
            // answer that was read before the listeners existed may miss every
            // record in between, and `staleTime` would keep that answer fresh
            // forever. They are not enabled yet, so this marks them stale without
            // a fetch of its own - the read that follows it is the one with the
            // listeners open.
            void queryClient.invalidateQueries({ queryKey: ["session", session] });
            setListening(session);
            // A session that opens now has no failure: the one that may be here
            // belongs to an earlier attempt, and its session guard would hide it
            // only while the session differs.
            setFailure(null);
        })();

        return () => {
            alive = false;
            for (const unsubscribe of off) unsubscribe();
            off = [];
            // The listeners of this effect are gone, so a later read of this
            // session may not be taken on the word of the effect before it: a
            // second visit waits for the listeners of its own run.
            setListening(null);
        };
    }, [session, appendEntry, clear, queryClient]);

    // The two listeners of this session are open, and only then is the snapshot
    // of this session read. A session whose listeners are not open yet has no such
    // read, so the records in between cannot pass unheard.
    const open = listening === session;
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open });

    // The snapshot is the authority for the transcript, and it is kept in the
    // store. It is not written from a cache that the visit before left behind: a
    // disabled query does not fetch, and it still hands out what it holds, so
    // `entries.data` may be the answer of the visit before this one. A visit
    // starts from what its own listeners heard.
    useEffect(() => {
        if (open && entries.data) hydrate(entries.data);
    }, [open, entries.data, hydrate]);

    // What a caller likely wants is the transcript, and that is the store, not
    // this query: `entries` is the raw snapshot of one read, while the store also
    // holds what the events appended since. The name says so.
    //
    // `listening` says whether this session's listeners are open. A consumer that
    // renders the store can gate on it, so that the frame before the listeners
    // exist shows nothing rather than a guess.
    return {
        state,
        snapshot: entries,
        stats,
        listening: open,
        error: failure?.session === session ? failure.error : null,
    };
}
