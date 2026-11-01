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
import type { HostId, SessionInfo } from "@/lib/bridge";
import type { SessionKey } from "@/lib/session/key";
import { isReachRead, reportReachFailure } from "./health";
import type { RunPhase } from "@/lib/transcript";

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
 * verdict (`lib/query/health.ts`).
 */
const queryCache = new QueryCache({
    onError: (error, query) => {
        bridge.log.error("a read failed", { key: query.queryHash, reason: bridge.asPieError(error).message });
        if (isReachRead(query.queryKey)) reportReachFailure();
    },
});

/** The client the app mounts with. */
export const queryClient = new QueryClient({ ...queryDefaults, queryCache });

/**
/**
 * The keys of one conversation's reads, in one place: the machine invalidates them by
 * name, and a drifted string would leave a screen reading a cache nobody refills.
 *
 * The connection and the file are both in the key. Two machines can hold the same path,
 * and one conversation's answer may never be read by the other.
 */
export const sessionKeys = {
    /** Every read of the conversation: the prefix of the keys below. */
    whole: (key: SessionKey) => ["session", key.host, key.session] as const,
    state: (key: SessionKey) => [...sessionKeys.whole(key), "state"] as const,
    entries: (key: SessionKey) => [...sessionKeys.whole(key), "entries"] as const,
    stats: (key: SessionKey) => [...sessionKeys.whole(key), "stats"] as const,
    commands: (key: SessionKey) => [...sessionKeys.whole(key), "commands"] as const,
    forkMessages: (key: SessionKey) => [...sessionKeys.whole(key), "forkMessages"] as const,
    models: (key: SessionKey) => [...sessionKeys.whole(key), "models"] as const,
    thinkingLevels: (key: SessionKey) => [...sessionKeys.whole(key), "thinkingLevels"] as const,
};

/** How often the usage is read with no event to say it changed. */
const STATS_FALLBACK_MS = 30_000;

/** How often to ask again for the usage, unless the read has failed for good. */
function statsRefetchInterval(query: { state: { status: string } }): number | false {
    return query.state.status === "error" ? false : STATS_FALLBACK_MS;
}

/**
 * The fallback poll of the usage, or nothing for a conversation with no run.
 *
 * A run that streams for minutes reports its cost in records this query does not see, so
 * the ring asks again while the run is not idle. A failed read is not asked again: its
 * answer would be the same one every thirty seconds for as long as the screen stays open.
 */
export function statsPoll(phase: RunPhase): typeof statsRefetchInterval | false {
    return phase === "idle" ? false : statsRefetchInterval;
}

/** One read that never retries: a failed command has already said why. */
function noRetry<T>(queryKey: readonly unknown[], queryFn: () => Promise<T>) {
    return queryOptions({ queryKey, queryFn, retry: false });
}

/**
 * The reads of one conversation, by the name of the conversation.
 *
 * None of them retries. A read fails with the named reason the command failed
 * (`not_attached` for a conversation that no pi serves): asking three more times makes
 * that reason arrive seconds later and changes nothing else. TanStack's default is
 * three tries.
 */
export const sessionQueries = {
    /** The state of a conversation: its model, its run, its name, its counts. */
    state: (key: SessionKey) => noRetry(sessionKeys.state(key), () => bridge.getState(key.host, key.session)),

    /** Every entry of a conversation and the leaf it points at. */
    entries: (key: SessionKey) => noRetry(sessionKeys.entries(key), () => bridge.getEntries(key.host, key.session)),

    /**
     * The usage of a conversation.
     *
     * The caller adds a fallback interval where it needs one: the ring of the header
     * reads this one again after a while, because a run that streams for minutes reports
     * its cost in events that this query does not see.
     */
    stats: (key: SessionKey) => noRetry(sessionKeys.stats(key), () => bridge.getSessionStats(key.host, key.session)),

    /** The commands that a prompt of this conversation can invoke, for the command menu. */
    commands: (key: SessionKey) => noRetry(sessionKeys.commands(key), () => bridge.getCommands(key.host, key.session)),

    /** The user messages that a fork of this conversation can start from, for the fork sheet. */
    forkMessages: (key: SessionKey) =>
        noRetry(sessionKeys.forkMessages(key), () => bridge.getForkMessages(key.host, key.session)),

    /** The models this conversation can use. */
    models: (key: SessionKey) =>
        noRetry(sessionKeys.models(key), () => bridge.getAvailableModels(key.host, key.session)),

    /** The thinking levels this conversation accepts. */
    thinkingLevels: (key: SessionKey) =>
        noRetry(sessionKeys.thinkingLevels(key), () => bridge.getAvailableThinkingLevels(key.host, key.session)),
};

/**
 * The conversations that pi wrote on one machine.
 *
 * The drawer reads this one, and its Refresh is what asks again: nothing announces a
 * conversation file that appears or grows, so this read is never stale on its own.
 */
export const sessionsQueries = {
    /** Every conversation of the machine, most recently written first. */
    list: (host: HostId) => noRetry(["sessions", host] as const, () => bridge.listSessions(host)),
};

/**
 * The directories of one machine, one level at a time, for the directory picker.
 *
 * An absent path is the home directory of the machine.
 */
export const directoryQueries = {
    /** The login home directory of the machine. */
    home: (host: HostId) => noRetry(["dirs", host, "home"] as const, () => bridge.homeDir(host)),
    /** One level of the directories of the machine. */
    list: (host: HostId, path: string) => noRetry(["dirs", host, path] as const, () => bridge.listDirs(host, path)),
};

/**
 * The one connection pie holds.
 *
 * Rust owns the connection, so a reload of the webview reads the same one instead of
 * losing it. Rust has no command that answers the connection itself, so this read is
 * composed: the conversations of the one name the product uses answer whether that
 * connection exists, and `not_connected` says it does not.
 *
 * A new connect changes the answer, and nothing announces that: time is its signal, so
 * it is read again on every mount. Whether the reach is still open travels on
 * `pi://connection/state`, not here.
 */

/** A connection as the commands can describe it. */
export interface HeldConnection {
    id: HostId;
    /** The conversations that have a pi process now. */
    sessions: SessionInfo[];
}

export const connectionQueries = {
    /** The connection pie holds now, or `null` when there is none. */
    current: () =>
        queryOptions({
            queryKey: ["connection", bridge.CONNECTION_ID] as const,
            queryFn: async (): Promise<HeldConnection | null> => {
                try {
                    return { id: bridge.CONNECTION_ID, sessions: await bridge.listSessions(bridge.CONNECTION_ID) };
                } catch (thrown) {
                    const error = bridge.asPieError(thrown);
                    if (error.kind === "not_connected") return null;
                    throw error;
                }
            },
            // A failure here is a broken IPC, and a retry cannot repair it.
            retry: false,
            staleTime: 0,
        }),
};

export * from "./health";
