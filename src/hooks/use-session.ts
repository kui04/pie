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

import { useSelector } from "@xstate/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { toast } from "sonner";
import { createActor } from "xstate";
import * as bridge from "@/lib/bridge";
import type { Event as SessionRecord } from "@/lib/protocol";
import { sessionQueries } from "@/lib/query";
import { createRecordTable, type RecordTranscript } from "@/lib/session-records";
import { isListening, isSwitching, phaseOf, sessionMachine, type SessionDeps } from "@/machines/session.machine";
import { useTranscriptStore } from "@/stores/transcript.store";

/**
 * How often the usage is read with no event to say it changed: a run that streams for
 * minutes reports its cost in records this query does not see.
 */
const STATS_FALLBACK_MS = 30_000;

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

    // What the chart needs from the world: the subscription, the switch, and the reads
    // a record makes stale. A test drives the whole graph with stubs of these.
    const deps = useMemo<SessionDeps>(
        () => ({
            apply: createRecordTable({
                session,
                transcript,
                invalidate: (key) => void queryClient.invalidateQueries({ queryKey: key }),
                toast,
            }).apply,
            listen: (onRecord, onStale) => openListeners(session, onRecord, onStale),
            switchSession: (path) => bridge.switchSession(session, path),
            reRead: () => void queryClient.invalidateQueries({ queryKey: ["session", session] }),
            afterSwitch: () => {
                clear();
                void queryClient.invalidateQueries({ queryKey: ["session", session] });
                void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            },
            opened: dropQueued,
        }),
        [session, transcript, clear, dropQueued, queryClient],
    );
    // Built once per session: `deps` is memorized on the session and its other members are
    // stable by construction, so a re-render never builds a second chart - which would
    // drop the phase of a run that is streaming.
    const machine = useMemo(() => createActor(sessionMachine, { input: deps }), [deps]);

    // The chart lives as long as this hook's session. A screen that renders another
    // session is keyed by it (`ChatScreen`), so the chart of the one before does not
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
    // session file) - so this runs on the answer, not on its shape.
    useEffect(() => {
        if (open && entries.data) useTranscriptStore.getState().hydrate(entries.data);
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
