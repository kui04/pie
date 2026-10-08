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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createActor } from "xstate";
import * as bridge from "@/lib/bridge";
import { sessionQueries } from "@/lib/query";
import { sessionMachine } from "@/machines/session.machine";
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
    /**
     * The run state of this session, fed by its events and by the reads of it. The
     * composer is what asks: while a run streams, its key stops the run instead of
     * sending (`machines/session.machine.ts`).
     */
    const [machine] = useState(() => createActor(sessionMachine));
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
    /** A switch of this session is on its way, and its transcript is being read. */
    const [switching, setSwitching] = useState(false);
    /** The same, for the guard: a state is not read again until the next render. */
    const inFlight = useRef(false);
    const appendEntry = useTranscriptStore((state) => state.appendEntry);
    const hydrate = useTranscriptStore((state) => state.hydrate);
    const clear = useTranscriptStore((state) => state.clear);
    const setQueue = useTranscriptStore((state) => state.setQueue);
    const appendBash = useTranscriptStore((state) => state.appendBash);

    // The actor lives as long as this hook. A screen that renders another session
    // is keyed by it (`ChatScreen`), so the machine of the one before does not
    // answer for the one now.
    useEffect(() => {
        machine.start();
        return () => {
            machine.stop();
        };
    }, [machine]);

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
            // The records of a closed listener are gone: only a read covers the time
            // before this subscription. The machine drops that read once it hears a
            // run event of its own.
            machine.send({ type: "LISTENING" });
            // Half a pair of listeners is worth less than none: a second subscription
            // that fails drops the first one again.
            try {
                const events = await bridge.onSessionEvent(session, (event) => {
                    switch (event.type) {
                        case "entry_appended":
                            // While a switch is on its way this entry may be the tail of
                            // the conversation being left (pi aborts a running turn
                            // before it replaces the session). The read that follows the
                            // switch carries everything the new conversation holds.
                            if (!inFlight.current) appendEntry(event.entry);
                            break;
                        case "session_info_changed":
                            // The name of the session changed; its state is stale.
                            void queryClient.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey });
                            break;
                        case "agent_start":
                            // The composer answers this one itself; the state of the
                            // session changes with it, because its `isStreaming` does.
                            machine.send({ type: "RUN_STARTED" });
                            break;
                        case "agent_end":
                            machine.send({ type: "RUN_ENDED", willRetry: event.willRetry });
                            break;
                        case "agent_settled":
                            machine.send({ type: "SETTLED" });
                            break;
                        case "queue_update":
                            // Pi reports both queues whole, so the store replaces its
                            // lists instead of appending to them.
                            setQueue({ steering: event.steering, followUp: event.followUp });
                            break;
                        case "bash_execution_update":
                            // The live card of a command the reader ran. The entry of
                            // `entry_appended` is the one that stays.
                            appendBash(event.delta);
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
    }, [session, appendEntry, appendBash, setQueue, clear, machine, queryClient, attempt]);

    // The listeners are open, so this session may be read: `enabled` keeps the reads
    // off until then, and the records in between cannot pass unheard.
    const open = listening === session;
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open, refetchInterval: statsRefetchInterval });

    // The read of the state is the authority for the time before the listeners
    // opened, and for that time only: the machine drops it once a run event was
    // heard, because its answer was built before that event.
    useEffect(() => {
        if (open && state.data) machine.send({ type: "STATE_READ", streaming: state.data.isStreaming });
    }, [open, state.data, machine]);

    // The snapshot is the authority for the transcript; it is not written from a
    // cache the visit before left behind, which the open gate above prevents.
    //
    // A read that brings the same entries back still writes them: a switch to
    // another conversation clears the store, and the answer of the read that
    // follows it may compare equal to the one before (the same session file).
    // Therefore this runs on the answer itself, not on its shape.
    useEffect(() => {
        if (open && entries.data) hydrate(entries.data);
    }, [open, entries.data, entries.dataUpdatedAt, hydrate]);

    /**
     * Makes this session continue the conversation of `path`.
     *
     * Nothing of the new conversation comes over the events of this session, so the
     * store is emptied and the reads are asked again. A failure reaches the caller,
     * which says what happened.
     *
     * A switch that is already on its way is not joined by a second one: pi runs the
     * commands of one session one after another, not together, so two of them would
     * leave whichever finished last on screen.
     */
    const switchTo = useCallback(
        async (path: string) => {
            // Read in the same tick as it is written: two picks of the drawer can
            // arrive before a render.
            if (inFlight.current) return;
            inFlight.current = true;
            setSwitching(true);
            try {
                const answer = await bridge.switchSession(session, path);
                if (answer.cancelled) return;
                clear();
                await queryClient.invalidateQueries({ queryKey: ["session", session] });
                // A switch aborts a run that is in flight (`teardownCurrent`) and that
                // abort persists to the session file it leaves: the listing now holds
                // a write this side has not seen.
                await queryClient.invalidateQueries({ queryKey: ["sessions"] });
            } finally {
                inFlight.current = false;
                setSwitching(false);
            }
        },
        [session, clear, queryClient],
    );

    // The transcript a caller wants is the store, not this query: `snapshot` is one
    // read, while the store also holds what the events appended since.
    //
    // `reopen` asks for the listeners again, for a screen whose failure is the
    // subscription itself.
    return {
        machine,
        state,
        snapshot: entries,
        stats,
        listening: open,
        error: failure?.session === session ? failure.error : null,
        reopen: () => setAttempt((times) => times + 1),
        switchTo,
        switching,
    };
}
