/**
 * The reads of one session, and the events they send to its chart (`.agents/rules/state.md`).
 *
 * The listeners open first and the reads follow: the event bus has no replay, and Rust sends
 * an event only to a window that already listens, so the other order would lose the records
 * in between. The actor itself belongs to the registry (`lib/sessions.ts`); this hook reads
 * it and owns nothing of its state.
 */

import { useSelector } from "@xstate/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect } from "react";
import { sessionQueries, statsPoll } from "@/lib/query";
import type { SessionRef } from "@/lib/sessions";
import { errorOf, isListening, isReady, phaseOf } from "@/machines/session.machine";

export function useSession(session: string, machine: SessionRef) {
    // The chart's state, as the screen reads it.
    const open = useSelector(machine, isListening);
    const ready = useSelector(machine, isReady);
    const phase = useSelector(machine, phaseOf);
    const failure = useSelector(machine, errorOf);

    // The listeners are open, so this session may be read: `enabled` keeps the reads off
    // until then, and the records in between cannot pass unheard.
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open, refetchInterval: statsPoll(phase) });

    // The read of the state may set the phase only while the chart's authority is open, and
    // only if it is newer than the last applied answer: its answer was built before the
    // records that followed its request. `dataUpdatedAt` orders two answers, so a refetch
    // is sent even when the data compares equal.
    useEffect(() => {
        if (open && state.data) {
            machine.send({ type: "STATE_READ", streaming: state.data.isStreaming, at: state.dataUpdatedAt });
        }
    }, [open, state.data, state.dataUpdatedAt, machine]);

    // The base read is the authority for the entries, and it is handed over before the next
    // paint, so the overlay is reconciled in the same frame.
    useLayoutEffect(() => {
        if (open && entries.data) {
            machine.send({ type: "SNAPSHOT", data: entries.data, at: entries.dataUpdatedAt });
        }
    }, [open, entries.data, entries.dataUpdatedAt, machine]);

    // The increment stands until an answer of the usage was written at or after the moment the
    // run settled: that answer holds the response as a message, so the increment would be the
    // same tokens twice. An answer from before the settle leaves the increment on screen, and
    // the chart keeps that moment for the read that does cover the response.
    useEffect(() => {
        if (open && stats.data) machine.send({ type: "STATS_READ", at: stats.dataUpdatedAt });
    }, [open, stats.data, stats.dataUpdatedAt, machine]);

    /** Asks for the listeners again, for a screen whose failure was the subscription. */
    const reopen = useCallback(() => machine.send({ type: "REOPEN" }), [machine]);

    return {
        phase,
        // A run in flight, whether the model has written yet or not: this is what the
        // composer and the drawer ask (their key stops, their rows wait).
        working: phase !== "idle",
        state,
        entries,
        stats,
        ready,
        listening: open,
        error: failure,
        reopen,
    };
}
