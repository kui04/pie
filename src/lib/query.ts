/**
 * The one query client, and the reads filed under it.
 *
 * A key mirrors the read it caches, so the place that invalidates a cache names
 * the same thing as the place that reads it. Events invalidate these caches;
 * they never write them (see `.agents/rules/state.md`).
 *
 * Nothing here is stale on its own, under the defaults below: every read is a
 * question to Rust over the one socket it owns, so time passing is not news, and
 * a window that regained focus has nothing new to say. A cache goes stale when
 * an event says the answer changed.
 */

import { queryOptions, QueryCache, QueryClient } from "@tanstack/react-query";
import * as bridge from "@/lib/bridge";
import { isReachFailure, reportReachFailure } from "@/lib/connection-health";
import type { RunPhase } from "@/lib/stream";

/**
 * The defaults every read of this app runs under, and the client they build.
 *
 * Exported so that a test builds its client the way the app does: a test with
 * TanStack's own defaults (`staleTime: 0`) would exercise a warm cache as if it
 * were cold, and the difference is exactly what a second visit depends on.
 */
export const queryDefaults = {
    defaultOptions: {
        queries: {
            staleTime: Infinity,
            refetchOnWindowFocus: false,
        },
    },
};

/**
 * Where a failed read is said out loud, and where the boundary hears about the reach.
 *
 * A read that fails is drawn where it was read - the failure sentence, the alert,
 * the disabled rows - and nowhere else: a webview is not a terminal, so nothing
 * of it would reach a log. This is the one place every read of the app passes
 * through, so one line here covers all of them, whichever screen asked.
 *
 * A failure of the reach is also the earliest news of a connection that ended: the reads
 * fail the moment the link goes, and the watch that ticks behind them is a tick late. The
 * boundary is told, and asks Rust what the reach is doing - the failure alone is not a
 * verdict (`lib/connection-health.ts`).
 */
const queryCache = new QueryCache({
    onError: (error, query) => {
        bridge.log.error("a read failed", { key: query.queryHash, reason: bridge.asPieError(error).message });
        if (isReachFailure(error)) reportReachFailure();
    },
});

/** The client the app mounts with. */
export const queryClient = new QueryClient({ ...queryDefaults, queryCache });

/**
 * The keys of one session's reads, in one place: the machine invalidates them by name, and
 * a drifted string would leave a screen reading a cache that nobody refills.
 */
export const sessionKeys = {
    /** Every read of the session: the prefix of the keys below. */
    whole: (session: string) => ["session", session] as const,
    state: (session: string) => [...sessionKeys.whole(session), "state"] as const,
    entries: (session: string) => [...sessionKeys.whole(session), "entries"] as const,
    stats: (session: string) => [...sessionKeys.whole(session), "stats"] as const,
    commands: (session: string) => [...sessionKeys.whole(session), "commands"] as const,
    extension: (session: string) => [...sessionKeys.whole(session), "extension"] as const,
    forkMessages: (session: string) => [...sessionKeys.whole(session), "forkMessages"] as const,
    models: (session: string) => [...sessionKeys.whole(session), "models"] as const,
    thinkingLevels: (session: string) => [...sessionKeys.whole(session), "thinkingLevels"] as const,
};

/** How often the usage is read with no event to say it changed. */
const STATS_FALLBACK_MS = 30_000;

/** How often to ask again for the usage, unless the read has failed for good. */
function statsRefetchInterval(query: { state: { status: string } }): number | false {
    return query.state.status === "error" ? false : STATS_FALLBACK_MS;
}

/**
 * The fallback poll of the usage, or nothing for a session with no run.
 *
 * A run that streams for minutes reports its cost in records this query does not see, so the
 * ring asks again while the run is not idle. A failed read is not asked again: its answer
 * would be the same one every thirty seconds for as long as the screen stays open.
 */
export function statsPoll(phase: RunPhase): typeof statsRefetchInterval | false {
    return phase === "idle" ? false : statsRefetchInterval;
}

/**
 * The reads of one session, by the name of the session.
 *
 * None of them retries. A read fails with the named reason that the command failed (`closed`
 * when pi is gone, `unknown_session` for a name that is not there): asking three more times
 * makes that reason arrive seconds later and changes nothing else. TanStack's default is
 * three tries.
 */
export const sessionQueries = {
    /** The state of a session: its model, its run, its name, its counts. */
    state: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.state(session),
            queryFn: () => bridge.getState(session),
            retry: false,
        }),

    /** Every entry of a session and the leaf it points at. */
    entries: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.entries(session),
            queryFn: () => bridge.getEntries(session),
            retry: false,
        }),

    /**
     * The usage of a session.
     *
     * The caller adds a fallback interval where it needs one: the ring of the
     * header reads this one again after a while, because a run that streams for
     * minutes reports its cost in events that this query does not see.
     */
    stats: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.stats(session),
            queryFn: () => bridge.getSessionStats(session),
            retry: false,
        }),

    /** The commands that a prompt of this session can invoke, for the command menu. */
    commands: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.commands(session),
            queryFn: () => bridge.getCommands(session),
            retry: false,
        }),

    /** The pending dialogs and extension values of this session. */
    extension: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.extension(session),
            queryFn: () => bridge.getExtensionState(session),
            retry: false,
        }),

    /** The user messages that a fork of this session can start from, for the fork sheet. */
    forkMessages: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.forkMessages(session),
            queryFn: () => bridge.getForkMessages(session),
            retry: false,
        }),

    /** The models this session can use. */
    models: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.models(session),
            queryFn: () => bridge.getAvailableModels(session),
            retry: false,
        }),

    /** The thinking levels this session accepts. */
    thinkingLevels: (session: string) =>
        queryOptions({
            queryKey: sessionKeys.thinkingLevels(session),
            queryFn: () => bridge.getAvailableThinkingLevels(session),
            retry: false,
        }),
};

/**
 * The sessions that pi wrote on the connected host.
 *
 * The drawer reads this one, and its Refresh is what asks again: nothing announces a
 * session file that appears or grows, so this read is never stale on its own.
 *
 * The host is part of the key: the answer is what that machine holds, and a second
 * connection in one run of pie would otherwise be handed the list of the first.
 */
export const sessionsQueries = {
    /** Every session of the host, most recently written first. */
    list: (endpoint: string) =>
        queryOptions({
            queryKey: ["sessions", endpoint] as const,
            queryFn: () => bridge.listSessions(),
            retry: false,
        }),
};

/**
 * The directories of the host, one level at a time, for the directory picker.
 *
 * The host is part of the key: the answer is what that machine holds, and a second
 * connection in one run of pie would otherwise be handed the directories of the
 * first. An absent path is the home directory of the machine.
 */
export const directoryQueries = {
    /** One level of the directories of the connected machine. */
    list: (endpoint: string, path?: string) =>
        queryOptions({
            queryKey: ["dirs", endpoint, path ?? ""] as const,
            queryFn: () => bridge.listDirs(path),
            retry: false,
        }),
};

/**
 * The one connection that pie holds, by the name of the read.
 *
 * The machine that opened the connection dies with the connect screen. This read
 * is how the workspace finds the session it subscribes to. Rust is the source of
 * truth, so a reload of the webview reads the same connection instead of losing
 * it.
 *
 * A new connect changes the answer, and nothing announces that: this is the one
 * read whose answer can change without an event. Therefore time is its signal,
 * and it is read again on every mount (`staleTime: 0` below). Every other read
 * waits for an event to be invalidated.
 */
export const connectionQueries = {
    /** The connection pie holds now, or `null` when there is none. */
    current: () =>
        queryOptions({
            queryKey: ["connection"] as const,
            queryFn: () => bridge.getConnection(),
            // A failure here is a broken IPC, and a retry cannot repair it.
            retry: false,
            staleTime: 0,
        }),
};
