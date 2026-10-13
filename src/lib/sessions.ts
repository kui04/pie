/**
 * The session actors of the app, by the id of the session they speak for, and the deps one
 * of them is built with.
 *
 * A session's chart lives as long as the screen holds it (v1: `ensureSession` on the mount
 * of a session, `forgetSession` on the leave; a later milestone syncs the map with the
 * sessions of the connection, so an actor outlives the screen that opened it). The map is
 * app-wide infrastructure, like the query client of `lib/query.ts`: it hands out actor refs,
 * and it holds no state of its own.
 *
 * The deps are a module factory: every part of them - the query client, the bridge,
 * the toast - is a singleton, so no React hook is involved, and a screen never creates
 * an actor. A chart stops when the last hand goes, at the end of that task: React's
 * StrictMode runs the effects of a mount twice (start, stop, start), and the screen that
 * starts again must find the chart, the transcript and the run it left.
 */

import { createActor, type ActorRefFrom } from "xstate";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as bridge from "@/lib/bridge";
import { sessionKeys } from "@/lib/query";
import type { Event as SessionRecord } from "@/lib/rpc-protocol";
import { toastNotice, type Notice, type ReadTarget } from "@/lib/session-records";
import { sessionMachine, type SessionDeps } from "@/machines/session.machine";

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
export function sessionDeps(session: string, client: QueryClient): SessionDeps {
    return {
        listen: (onRecord, onLifecycle) => openListeners(session, onRecord, onLifecycle),
        reRead: (target: ReadTarget) => void client.invalidateQueries({ queryKey: sessionKeys[target](session) }),
        notice: (notice: Notice) => toastNotice(notice, toast),
    };
}

/** One slot: the actor, how many screens hold it, and the stop that waits for the task. */
interface Slot {
    actor: SessionRef;
    count: number;
    /** The token of the stop that is waiting; a hand that comes back clears it. */
    pending: symbol | null;
}

const slots = new Map<string, Slot>();
const readers = new Set<() => void>();

/** Tells every reader of the map that it changed. */
function notify(): void {
    for (const read of readers) read();
}

/** Starts the chart of a session, or counts another hand on the one that runs. */
export function ensureSession(session: string, client: QueryClient): void {
    const held = slots.get(session);
    if (held !== undefined) {
        held.count += 1;
        held.pending = null;
        return;
    }
    const actor = createActor(sessionMachine, { input: sessionDeps(session, client) });
    actor.start();
    slots.set(session, { actor, count: 1, pending: null });
    notify();
}

/** Drops one hand; the chart stops when the last one goes, and the task it went in ends. */
export function forgetSession(session: string): void {
    const held = slots.get(session);
    if (held === undefined) return;
    held.count = Math.max(0, held.count - 1);
    if (held.count > 0) return;
    const token: symbol = Symbol(session);
    held.pending = token;
    queueMicrotask(() => {
        if (held.pending !== token) return;
        held.actor.stop();
        if (slots.get(session) === held) slots.delete(session);
        notify();
    });
}

/** The chart of a session, or `null` while none runs for it. */
export function sessionOf(session: string): SessionRef | null {
    return slots.get(session)?.actor ?? null;
}

/** Reads the ids of the running charts, for a component that renders them. */
export function subscribeSessions(read: () => void): () => void {
    readers.add(read);
    return () => {
        readers.delete(read);
    };
}
