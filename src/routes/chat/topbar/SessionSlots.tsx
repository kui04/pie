/**
 * The session's own slots of the bar: what it is called, and how full its context is.
 *
 * The rest of the bar - the way to the list, the window's own keys - belongs to the window and
 * stands still. These two belong to the conversation in view, so they are the only part of the
 * bar that changes when another conversation opens, and they fade while the page under them does.
 *
 * The reads are the ones the region already runs (`useSession.ts`), from the same cache: this
 * component fetches nothing of its own, and it sends nothing - the region owns the reads, and a
 * second sender of the same event would only be a second opinion.
 */

import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { isListening, isReady, phaseOf } from "@/machines/session.machine";
import { sessionQueries } from "@/lib/query";
import type { SessionRef } from "@/lib/sessions";
import { withLiveUsage } from "@/routes/chat/topbar/usage";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { statsPoll } from "@/hooks/useSession";

export interface SessionSlotsProps {
    session: string;
    machine: SessionRef;
    cwd: string | null;
}

export function SessionSlots({ session, machine, cwd }: SessionSlotsProps) {
    const open = useSelector(machine, isListening);
    const ready = useSelector(machine, isReady);
    const phase = useSelector(machine, phaseOf);
    const live = useSelector(machine, (snapshot) => snapshot.context.usage);

    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open, refetchInterval: statsPoll(phase) });

    return (
        <SessionTopbar
            name={state.data?.sessionName ?? null}
            cwd={cwd}
            stats={withLiveUsage(stats.data ?? null, live?.usage ?? null)}
            auto={state.data?.autoCompactionEnabled ?? false}
            ready={ready && entries.data !== undefined}
        />
    );
}
