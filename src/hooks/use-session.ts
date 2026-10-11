/**
 * The workspace's one session: the seam of its stream (`.agents/rules/state.md`).
 * It hands the chart its means, holds the three reads, and nothing else: the states of
 * the feed are `machines/session.machine.ts`, and where a record goes is
 * `lib/session-records.ts`.
 *
 * The listeners open first and the reads follow: the event bus has no replay, and Rust
 * sends an event only to a window that already listens, so the other order would lose
 * the records in between.
 */

import { useActorRef, useSelector } from "@xstate/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as bridge from "@/lib/bridge";
import type { Event as SessionRecord } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";
import { createRecordTable, type RecordTranscript } from "@/lib/session-records";
import { isListening, isSwitching, phaseOf, sessionMachine, type SessionDeps } from "@/machines/session.machine";
import { useTranscriptStore } from "@/stores/transcript.store";

/**
 * How often the usage is read with no event to say it changed: a run that streams for
 * minutes reports its cost in records this query does not see.
 */
const STATS_FALLBACK_MS = 30_000;

/**
 * The records that arrive many times a second while something streams.
 *
 * The log of the frontend is for the shape of a run, not for its bytes: one line
 * per delta would be a log nobody can read, and it would cost a call into Rust
 * per delta as well. What they add up to is an entry, and the read at the end of
 * the run is where that is seen.
 */
const STREAMING: ReadonlySet<string> = new Set(["message_update", "tool_execution_update", "bash_execution_update"]);

/** How often to ask again for the usage - never for a read that already failed, whose
 * answer would be the same one, every 30 seconds, for as long as the screen stays open. */
export function statsRefetchInterval(query: { state: { status: string } }): number | false {
    return query.state.status === "error" ? false : STATS_FALLBACK_MS;
}

/**
 * Opens the two subscriptions of a session: both, or none. Half a pair is worth less
 * than none - the records the missing one would have carried are gone either way.
 */
async function openListeners(
    session: string,
    onRecord: (record: SessionRecord) => void,
    onStale: () => void,
): Promise<bridge.Unsubscribe> {
    const events = await bridge.onSessionEvent(session, onRecord);
    try {
        const state = await bridge.onSessionState(session, onStale);
        bridge.log.debug("the listeners of the session are open", { session });
        return () => {
            events();
            state();
        };
    } catch (thrown) {
        events();
        throw thrown;
    }
}

export function useSession(session: string) {
    // One session for one mount. A screen that shows another session is another
    // screen (`ChatScreen` renders the session as its `key`), and the chart below
    // cannot be rebuilt for a name that arrives later. A different name here is a
    // screen that lost its key: it would read one session while it listens to
    // another, so it says so instead.
    const [named] = useState(session);
    if (named !== session) {
        throw new Error(`useSession holds one session (${named}) for its mount, not ${session}`);
    }

    const queryClient = useQueryClient();
    const appendEntry = useTranscriptStore((state) => state.appendEntry);
    const clear = useTranscriptStore((state) => state.clear);
    const dropQueued = useTranscriptStore((state) => state.dropQueued);
    const setQueue = useTranscriptStore((state) => state.setQueue);
    const appendBash = useTranscriptStore((state) => state.appendBash);
    const liveStart = useTranscriptStore((state) => state.liveStart);
    const liveDelta = useTranscriptStore((state) => state.liveDelta);
    const liveEnd = useTranscriptStore((state) => state.liveEnd);
    const liveToolStart = useTranscriptStore((state) => state.liveToolStart);
    const liveToolUpdate = useTranscriptStore((state) => state.liveToolUpdate);
    const liveToolEnd = useTranscriptStore((state) => state.liveToolEnd);
    const liveRetrying = useTranscriptStore((state) => state.liveRetrying);
    const setLiveUsage = useTranscriptStore((state) => state.setLiveUsage);
    const settleLiveUsage = useTranscriptStore((state) => state.settleLiveUsage);

    // One table per session: the attempt a summary retry named lives and dies with it.
    const transcript = useMemo<RecordTranscript>(
        () => ({
            appendEntry,
            setQueue,
            appendBash,
            liveStart,
            liveDelta,
            liveEnd,
            liveToolStart,
            liveToolUpdate,
            liveToolEnd,
            liveRetrying,
            setLiveUsage,
        }),
        [
            appendEntry,
            setQueue,
            appendBash,
            liveStart,
            liveDelta,
            liveEnd,
            liveToolStart,
            liveToolUpdate,
            liveToolEnd,
            liveRetrying,
            setLiveUsage,
        ],
    );

    // What the store holds between a switch and the answer of the new conversation is
    // the conversation that is leaving. That answer does not merge with those entries -
    // they are another conversation - so it is written in their place, in the frame it
    // arrives. Clearing at the switch instead would empty the page that is still fading
    // out, when a fast switch answers before the fade is over.
    const replacing = useRef(false);

    // What the chart needs from the world: the subscription, the switch, and the reads
    // a record makes stale. A test drives the whole graph with stubs of these.
    const deps = useMemo<SessionDeps>(() => {
        const records = createRecordTable({
            session,
            transcript,
            invalidate: (key) => void queryClient.invalidateQueries({ queryKey: key }),
            toast,
        });

        return {
            apply: (record, drawing) => {
                // The records that arrive many times a second while something streams - a
                // delta of a response, a tool's output, a shell command's - would drown the
                // log, and the answer of the read at the end of the run tells the same
                // story once.
                if (!STREAMING.has(record.type)) {
                    bridge.log.debug("a record arrived", { session, type: record.type, drawing });
                }

                records.apply(record, drawing);
            },
            listen: (onRecord, onStale) => openListeners(session, onRecord, onStale),
            switchSession: (path) => bridge.switchSession(session, path),
            reRead: () => void queryClient.invalidateQueries({ queryKey: ["session", session] }),
            afterSwitch: () => {
                replacing.current = true;
                // The answer that is cached under this key describes the conversation
                // that was left, and the key does not say which conversation it is:
                // dropping it is what keeps the window loading until the answer of the
                // new one arrives, instead of drawing its own emptiness as a fact.
                queryClient.removeQueries({ queryKey: ["session", session, "entries"] });
                void queryClient.invalidateQueries({ queryKey: ["session", session] });
                void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            },
            opened: dropQueued,
        };
    }, [session, transcript, dropQueued, queryClient]);
    // Built once per mounted screen: `ChatScreen` keys the session, so another
    // session is another mount and another chart. `useActorRef` owns the
    // lifecycle, which a hand-written start/stop does not survive: `stop` is
    // final for an actor, and Strict Effects (and a hot reload) reconnect an
    // effect over the actor the memo already holds, so the second start would
    // be the silent no-op that leaves the feed closed forever.
    const machine = useActorRef(sessionMachine, { input: deps });

    // A different session starts from nothing: a consumer reads the store while it
    // renders, so clearing after a passive effect would paint one frame of the last
    // session's entries.
    useLayoutEffect(() => {
        clear();
    }, [session, clear]);

    // The chart's state, as the screen reads it.
    const open = useSelector(machine, isListening);
    const phase = useSelector(machine, phaseOf);
    const switching = useSelector(machine, isSwitching);
    const failure = useSelector(machine, (snapshot) => snapshot.context.error);

    // The listeners are open, so this session may be read: `enabled` keeps the reads
    // off until then, and the records in between cannot pass unheard. A switch keeps
    // them on - the read that follows it is the answer of the new conversation.
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open, refetchInterval: statsRefetchInterval });

    // The read of the state is the authority for the time before the listeners opened,
    // and for that time only: the chart drops it once a record of a run was heard,
    // because its answer was built before that record.
    useEffect(() => {
        if (open && state.data) machine.send({ type: "STATE_READ", streaming: state.data.isStreaming });
    }, [open, state.data, machine]);

    // The increment stands until a read of the usage answers that was asked for after the
    // response's last delta: that answer holds the response as a message, so the increment
    // would be the same tokens twice.
    useEffect(() => {
        settleLiveUsage(stats.dataUpdatedAt);
    }, [stats.dataUpdatedAt, settleLiveUsage]);

    // The snapshot is the authority for the transcript, and the open gate above keeps a
    // cache of an earlier visit out of it. A read that brings the same entries back still
    // writes them - after a switch the answer may compare equal to the one before (the same
    // session file) - so this runs on the answer, not on its shape. It is a layout effect
    // for the same reason the clear above is: a reader draws what the store holds, and a
    // passive effect would paint one frame of a conversation that is not the one the read
    // just answered about.
    useLayoutEffect(() => {
        if (!open || !entries.data) return;
        if (replacing.current) {
            replacing.current = false;
            useTranscriptStore.getState().replace(entries.data);
            return;
        }
        useTranscriptStore.getState().hydrate(entries.data);
    }, [open, entries.data, entries.dataUpdatedAt]);

    /**
     * Makes this session continue the conversation of `path`.
     *
     * The chart holds whether a switch is on its way, because that is what decides
     * whether a record may draw a row; this function does the asking. A failure
     * reaches the caller, which says what happened.
     */
    const switchTo = useCallback(
        async (path: string) => {
            // Read in the same tick as it is written: two picks can arrive before a render.
            // A feed that is not live has no conversation to leave, and the chart would drop
            // a switch while Rust made it - so it is refused before it is asked for.
            const feed = machine.getSnapshot();
            if (!isListening(feed) || isSwitching(feed)) return;
            machine.send({ type: "SWITCH" });
            // The screen may be gone when the switch answers, and the chart with it: a
            // stopped actor takes no event and says so on the console.
            const hears = () => machine.getSnapshot().status === "active";
            try {
                const answer = await deps.switchSession(path);
                if (hears()) machine.send({ type: answer.cancelled ? "SWITCH_ABANDONED" : "SWITCH_DONE" });
            } catch (thrown) {
                if (hears()) machine.send({ type: "SWITCH_FAILED" });
                throw thrown;
            }
        },
        [machine, deps],
    );

    /** Asks for the listeners again, for a screen whose failure was the subscription. */
    const reopen = useCallback(() => machine.send({ type: "REOPEN" }), [machine]);

    // The transcript itself is the store; this read is its snapshot, without what came
    // after it.
    return {
        phase,
        // A run in flight, whether the model has written yet or not: this is what the
        // composer and the drawer ask (their key stops, their rows wait).
        working: phase !== "idle",
        state,
        snapshot: entries,
        stats,
        listening: open,
        error: failure,
        reopen,
        switchTo,
        switching,
    };
}
