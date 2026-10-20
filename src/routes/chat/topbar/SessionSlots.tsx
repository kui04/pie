/**
 * The session's own slots of the bar: what it is called, and how full its context is.
 *
 * The rest of the bar - the way to the list, the window's own keys - belongs to the window and
 * stands still. These two belong to the conversation in view, so they are the only part of the
 * bar that changes when another conversation opens, and they fade while the page under them does.
 *
 * The reads are the ones the region already runs (`useSession.ts`), from the same cache: these
 * components fetch nothing of their own that the region does not, and they send nothing - the
 * region owns the reads, and a second sender of the same event would only be a second opinion.
 */

import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { isListening, isReady, phaseOf } from "@/machines/session.machine";
import { sessionQueries, sessionsQueries } from "@/lib/query";
import type { SessionRef } from "@/lib/sessions";
import { withLiveUsage } from "@/routes/chat/topbar/usage";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { UsagePopover } from "@/routes/chat/topbar/UsagePopover";
import { statsPoll } from "@/hooks";

export interface SessionSlotsProps {
    session: string;
    machine: SessionRef;
    endpoint: string;
    cwd: string | null;
}

export function SessionSlots({ session, machine, endpoint, cwd }: SessionSlotsProps) {
    const open = useSelector(machine, isListening);
    const ready = useSelector(machine, isReady);

    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const extension = useQuery({ ...sessionQueries.extension(session), enabled: open });
    const entries = useQuery({ ...sessionQueries.entries(session), enabled: open });
    // The list row is the same conversation: its words are the fallback the bar
    // needs when pi has no name for this session.
    const sessions = useQuery({ ...sessionsQueries.list(endpoint), enabled: open });
    const summary = sessions.data?.find((item) => item.path === state.data?.sessionFile);

    return (
        <SessionTopbar
            name={state.data?.sessionName ?? summary?.name ?? null}
            firstMessage={summary?.firstMessage ?? null}
            cwd={cwd}
            extensionTitle={extension.data?.title ?? null}
            ready={ready && entries.data !== undefined}
        />
    );
}

/** The ring in the bar, and the reading behind it. */
export function SessionUsage({ session, machine }: { session: string; machine: SessionRef }) {
    const open = useSelector(machine, isListening);
    const phase = useSelector(machine, phaseOf);
    const live = useSelector(machine, (snapshot) => snapshot.context.usage);
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const stats = useQuery({ ...sessionQueries.stats(session), enabled: open, refetchInterval: statsPoll(phase) });

    return (
        <UsagePopover
            id="session-usage"
            stats={withLiveUsage(stats.data ?? null, live?.usage ?? null)}
            auto={state.data?.autoCompactionEnabled ?? false}
        />
    );
}
