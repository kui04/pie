/**
 * The session actors of the app, by the id of the session they speak for, and the deps one of
 * them is built with.
 *
 * The actors follow the sessions of the connection, not the screen: `syncSessions` runs for the
 * list that Rust answers with, so a session that is not on screen keeps its listeners, its
 * overlay, its rows and its phase - the screen that selects it later shows the run as it is. The
 * map is app-wide infrastructure, like the query client of `lib/query/index.ts`: it hands out actor
 * refs and the phase of each, and it holds no state of its own.
 *
 * The deps are a module factory: every part of them - the query client, the bridge, the toast -
 * is a singleton, so no React hook is involved, and a screen never creates an actor.
 */

import { createActor, type ActorRefFrom } from "xstate";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as bridge from "@/lib/bridge";
import { sessionKeys } from "@/lib/query";
import type { Event as SessionRecord } from "@/lib/rpc-protocol";
import type { RunPhase } from "@/lib/transcript";
import { toastNotice, type Notice, type ReadTarget } from "./records";
import { phaseOf, sessionMachine, type SessionDeps } from "@/machines/session.machine";

/** One running chart of one session. */
export type SessionRef = ActorRefFrom<typeof sessionMachine>;

/**
 * Opens the two subscriptions of a session: both, or none. Half a pair is worth less than
 * none - the records the missing one would have carried are gone either way.
 */
async function openListeners(
    session: string,
    onRecord: (record: SessionRecord) => void,
    onLifecycle: (life: bridge.SessionLifecycle) => void,
): Promise<bridge.Unsubscribe> {
    const events = await bridge.onSessionEvent(session, onRecord);
    try {
        const state = await bridge.onSessionState(session, onLifecycle);
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

/**
 * The deps of one session: the listeners, the reads a record makes stale, the words.
 *
 * The client is the one the screen reads through, so an invalidation reaches the same
 * cache the reads fill: the app mounts one client, and a test mounts its own.
 */
function sessionDeps(session: string, client: QueryClient): SessionDeps {
    return {
        listen: (onRecord, onLifecycle) => openListeners(session, onRecord, onLifecycle),
        reRead: (target: ReadTarget) => void client.invalidateQueries({ queryKey: sessionKeys[target](session) }),
        notice: (notice: Notice) => toastNotice(notice, toast),
    };
}

const slots = new Map<string, SessionRef>();
const readers = new Set<() => void>();
/** One subscription per slot, to the changes of that actor. */
const watching = new Map<string, () => void>();
/** The phases of every session, rebuilt only when one of them changes. */
let phaseMap: ReadonlyMap<string, RunPhase> = new Map();

/** Tells every reader of the registry that it changed. */
function notify(): void {
    for (const read of readers) read();
}

/** The phase of each session the registry holds, as one value a list can light its rows by. */
export function phases(): ReadonlyMap<string, RunPhase> {
    return phaseMap;
}

/** Keeps the phase map in step with one actor, and tells the readers when it moved. */
function hearPhase(session: string, actor: SessionRef): void {
    const phase = phaseOf(actor.getSnapshot());
    if (phaseMap.get(session) === phase) return;
    const next = new Map(phaseMap);
    next.set(session, phase);
    phaseMap = next;
    notify();
}

/** Starts the chart of a session, or nothing when its chart is already running. */
export function ensureSession(session: string, client: QueryClient): void {
    if (slots.has(session)) return;
    const actor = createActor(sessionMachine, { input: sessionDeps(session, client) });
    actor.start();
    slots.set(session, actor);
    const subscription = actor.subscribe(() => hearPhase(session, actor));
    watching.set(session, () => subscription.unsubscribe());
    hearPhase(session, actor);
}

/** Stops the chart of a session: the connection no longer holds it. */
export function forgetSession(session: string): void {
    const actor = slots.get(session);
    if (actor === undefined) return;
    watching.get(session)?.();
    watching.delete(session);
    slots.delete(session);
    actor.stop();
    const next = new Map(phaseMap);
    next.delete(session);
    phaseMap = next;
    notify();
}

/**
 * Keeps the charts in step with the sessions of one connection: one for each, and none for the
 * rest. A connection that holds no session - and a window that holds no connection - forgets
 * every chart, because a chart speaks for a process that is gone.
 */
export function syncSessions(sessions: readonly string[], client: QueryClient): void {
    const held = new Set(sessions);
    for (const session of sessions) ensureSession(session, client);
    for (const session of [...slots.keys()]) {
        if (!held.has(session)) forgetSession(session);
    }
}

/** The chart of a session, or `null` while none runs for it. */
export function sessionOf(session: string): SessionRef | null {
    return slots.get(session) ?? null;
}

/** Reads the registry, for a component that shows a session or a list of them. */
export function subscribeSessions(read: () => void): () => void {
    readers.add(read);
    return () => {
        readers.delete(read);
    };
}
