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
import { toast } from "sonner";
import { createActor } from "xstate";
import * as bridge from "@/lib/bridge";
import type { AssistantMessageEvent, SummarizationRetrySource, Usage } from "@/lib/protocol";
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
 * The toast of a retry, so that a second one replaces the first instead of stacking on
 * it, and so that the retry that succeeded can take it away.
 */
const RETRY_TOAST = "session-retry";

/**
 * The toast of a summarization retry (the one pi runs by itself when a compaction or a
 * branch summary fails): one id, so that a second attempt replaces the first and the
 * attempt that works can take it away.
 */
const SUMMARY_TOAST = "session-summary-retry";

/** What a summarization retry is working on, and which attempt it is. */
function summarising(source: SummarizationRetrySource, at: { attempt: number; maxAttempts: number } | null): string {
    const what = source.source === "branchSummary" ? "Writing a branch summary" : "Compacting the context";
    return at === null ? what : `${what} - attempt ${at.attempt} of ${at.maxAttempts}`;
}

/**
 * The records that write the run's own rows. A switch of the session drops them: the
 * record that arrives while the switch is on its way may be the tail of the run of the
 * conversation being left, and the read that follows the switch carries everything the
 * new one holds.
 */
const LIVE_RECORDS = new Set([
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
]);

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
    const liveRunStart = useTranscriptStore((state) => state.liveRunStart);
    const liveStart = useTranscriptStore((state) => state.liveStart);
    const liveDelta = useTranscriptStore((state) => state.liveDelta);
    const liveEnd = useTranscriptStore((state) => state.liveEnd);
    const liveToolStart = useTranscriptStore((state) => state.liveToolStart);
    const liveToolUpdate = useTranscriptStore((state) => state.liveToolUpdate);
    const liveToolEnd = useTranscriptStore((state) => state.liveToolEnd);
    const liveRetrying = useTranscriptStore((state) => state.liveRetrying);
    const setLiveUsage = useTranscriptStore((state) => state.setLiveUsage);
    const clearLiveUsage = useTranscriptStore((state) => state.clearLiveUsage);

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

    // The deltas of one frame are applied together and before anything that is not a
    // delta: the transcript of a streamed answer arrives as tens of records a second,
    // each of which would fold the rows and parse the markdown again, and a tool call's
    // arguments must not be read before the text they are part of.
    const deltas = useRef<{ usage: Usage; event: AssistantMessageEvent }[]>([]);
    /** The attempt the last scheduled summarization retry named. */
    const summarisingAt = useRef<{ attempt: number; maxAttempts: number } | null>(null);
    /** When the last delta of a response arrived, against the reads of the usage. */
    const lastDelta = useRef(0);
    const frame = useRef<number | null>(null);

    useEffect(() => {
        let alive = true;
        let off: bridge.Unsubscribe[] = [];

        const flushDeltas = () => {
            if (frame.current !== null) {
                cancelAnimationFrame(frame.current);
                frame.current = null;
            }
            // The whole batch in one go, so that React renders once for it.
            const batch = deltas.current;
            deltas.current = [];
            for (const delta of batch) {
                liveDelta(delta.event);
                setLiveUsage(delta.usage);
            }
            if (batch.length > 0) lastDelta.current = Date.now();
        };

        /** Holds one delta of the streaming answer until the frame it belongs to. */
        const holdDelta = (usage: Usage, event: AssistantMessageEvent) => {
            deltas.current.push({ usage, event });
            frame.current ??= requestAnimationFrame(() => {
                frame.current = null;
                flushDeltas();
            });
        };

        void (async () => {
            // The records of a closed listener are gone: only a read covers the time
            // before this subscription. The machine drops that read once it hears a
            // run event of its own.
            machine.send({ type: "LISTENING" });
            // Half a pair of listeners is worth less than none: a second subscription
            // that fails drops the first one again.
            try {
                const events = await bridge.onSessionEvent(session, (event) => {
                    // Everything but a delta goes after the deltas that came before it.
                    if (event.type !== "message_update") flushDeltas();
                    if (inFlight.current && LIVE_RECORDS.has(event.type)) return;

                    switch (event.type) {
                        case "message_start":
                            liveStart(event.message);
                            break;
                        case "message_update":
                            holdDelta(event.usage, event.assistantMessageEvent);
                            break;
                        case "message_end":
                            // The final message is the authority over what the deltas
                            // built, and a run reports its cost while it streams.
                            liveEnd(event.message);
                            void queryClient.invalidateQueries({ queryKey: sessionQueries.stats(session).queryKey });
                            break;
                        case "tool_execution_start":
                            // A nested call (one that a tool made) is drawn inside its
                            // parent's card, so the run does not open a call of its own.
                            if (event.parentToolCallId === undefined) {
                                liveToolStart({ toolCallId: event.toolCallId, args: event.args });
                            }
                            break;
                        case "tool_execution_update":
                            liveToolUpdate({
                                toolCallId: event.toolCallId,
                                toolName: event.toolName,
                                partialResult: event.partialResult,
                            });
                            break;
                        case "tool_execution_end":
                            liveToolEnd({
                                toolCallId: event.toolCallId,
                                toolName: event.toolName,
                                result: event.result,
                                isError: event.isError,
                            });
                            break;
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
                            // The run begins from nothing: its first output is what the
                            // line under the transcript waits for.
                            liveRunStart();
                            machine.send({ type: "RUN_STARTED" });
                            break;
                        case "agent_end":
                            // Pi runs the turn again by itself: the failure the run
                            // just wrote is not the end of it, so nothing says so yet.
                            if (event.willRetry) liveRetrying();
                            machine.send({ type: "RUN_ENDED", willRetry: event.willRetry });
                            break;
                        case "agent_settled":
                            machine.send({ type: "SETTLED" });
                            // The run is over and its messages are in the session file
                            // now: the read that follows replaces the rows the run drew
                            // with the entries, which are the authority.
                            void queryClient.invalidateQueries({ queryKey: ["session", session] });
                            break;
                        case "compaction_end":
                            // The summary is an entry like any other, and no event
                            // carries it: the fold of the snapshot is what shows it.
                            void queryClient.invalidateQueries({ queryKey: ["session", session] });
                            break;
                        case "auto_retry_start":
                            toast.warning("Pi is retrying the request", {
                                id: RETRY_TOAST,
                                description: `${event.errorMessage} - attempt ${event.attempt} of ${event.maxAttempts}`,
                            });
                            break;
                        case "auto_retry_end":
                            if (event.success) {
                                toast.dismiss(RETRY_TOAST);
                            } else {
                                toast.error("Pi gave up on the request", {
                                    id: RETRY_TOAST,
                                    description: event.finalError,
                                });
                            }
                            break;
                        case "summarization_retry_scheduled":
                            summarisingAt.current = { attempt: event.attempt, maxAttempts: event.maxAttempts };
                            toast.warning("Pi is retrying the summary", {
                                id: SUMMARY_TOAST,
                                description: `${event.errorMessage} - attempt ${event.attempt} of ${event.maxAttempts}`,
                            });
                            break;
                        case "summarization_retry_attempt_start":
                            // The attempt that is running now says what pi works on: a
                            // compaction of the context, or a summary of a branch.
                            toast.warning("Pi is retrying the summary", {
                                id: SUMMARY_TOAST,
                                description: summarising(event, summarisingAt.current),
                            });
                            break;
                        case "summarization_retry_finished":
                            summarisingAt.current = null;
                            toast.dismiss(SUMMARY_TOAST);
                            break;
                        case "thinking_level_changed":
                            // The level is part of the state of a session, and the picker
                            // of the composer reads it from there.
                            void queryClient.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey });
                            break;
                        case "turn_end":
                            // A run reports its cost while it streams; the usage of
                            // the session changed with it.
                            void queryClient.invalidateQueries({ queryKey: sessionQueries.stats(session).queryKey });
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
            if (frame.current !== null) {
                cancelAnimationFrame(frame.current);
                frame.current = null;
            }
            deltas.current = [];
            for (const unsubscribe of off) unsubscribe();
            off = [];
            // A later read of this session may not be taken on the word of this effect.
            setListening(null);
        };
    }, [
        session,
        appendEntry,
        appendBash,
        setQueue,
        clear,
        liveRunStart,
        liveStart,
        liveDelta,
        liveEnd,
        liveToolStart,
        liveToolUpdate,
        liveToolEnd,
        liveRetrying,
        setLiveUsage,
        machine,
        queryClient,
        attempt,
    ]);

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

    // The usage of the streaming response stands until a read of the usage answers that
    // was asked for after its last delta: that answer holds the response as a message, so
    // the increment would be the same tokens twice. A response that streams at that moment
    // keeps its own reading - its deltas write them again anyway.
    useEffect(() => {
        if (stats.dataUpdatedAt >= lastDelta.current) clearLiveUsage();
    }, [stats.dataUpdatedAt, clearLiveUsage]);

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
