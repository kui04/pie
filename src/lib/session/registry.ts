/**
 * The charts of the app, one for each conversation that pi serves, and the deps one of
 * them is built with.
 *
 * The actors follow the conversations of the connection, not the screen: `syncSessions`
 * runs for the list that Rust answers with, so a conversation that is not on screen keeps
 * its listener, its overlay, its rows and its phase - the screen that selects it later
 * shows the run as it is. The map is app-wide infrastructure, like the query client of
 * `lib/query/index.ts`: it hands out actor refs and the phase of each, and it holds no
 * state of its own.
 *
 * The deps are a module factory: every part of them - the query client, the bridge, the
 * toast - is a singleton, so no React hook is involved, and a screen never creates an actor.
 */

import { createActor, type ActorRefFrom } from "xstate";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useExtensionStore } from "@/lib/extension";
import { sessionKeys } from "@/lib/query";
import type { RunPhase } from "@/lib/transcript";
import { phaseOf, sessionMachine, type SessionDeps } from "@/machines/session.machine";
import { idOf, type SessionKey } from "./key";
import { toastNotice, type Notice, type ReadTarget } from "./records";
import { subscribe } from "./stream";

/** One running chart of one conversation. */
export type SessionRef = ActorRefFrom<typeof sessionMachine>;

/**
 * The deps of one conversation: the shared stream, the reads a record makes stale, the
 * words.
 *
 * The client is the one the screen reads through, so an invalidation reaches the same
 * cache the reads fill: the app mounts one client, and a test mounts its own.
 */
function sessionDeps(key: SessionKey, client: QueryClient): SessionDeps {
    return {
        listen: (onRecord, onEnded) => subscribe(key, (event) => onRecord(event.event), onEnded),
        reRead: (target: ReadTarget) => void client.invalidateQueries({ queryKey: sessionKeys[target](key) }),
        notice: (notice: Notice) => toastNotice(notice, toast),
    };
}

const slots = new Map<string, SessionRef>();
const readers = new Set<() => void>();
/** One subscription per slot, to the changes of that actor. */
const watching = new Map<string, () => void>();
/** The phases of every conversation, rebuilt only when one of them changes. */
let phaseMap: ReadonlyMap<string, RunPhase> = new Map();

/** Tells every reader of the registry that it changed. */
function notify(): void {
    for (const read of readers) read();
}

/** The phase of each conversation the registry holds, keyed by `idOf`. */
export function phases(): ReadonlyMap<string, RunPhase> {
    return phaseMap;
}

/** Keeps the phase map in step with one actor, and tells the readers when it moved. */
function hearPhase(id: string, actor: SessionRef): void {
    const phase = phaseOf(actor.getSnapshot());
    if (phaseMap.get(id) === phase) return;
    const next = new Map(phaseMap);
    next.set(id, phase);
    phaseMap = next;
    notify();
}

/** Starts the chart of a conversation, or nothing when its chart is already running. */
export function ensureSession(key: SessionKey, client: QueryClient): void {
    const id = idOf(key);
    if (slots.has(id)) return;
    const actor = createActor(sessionMachine, { input: sessionDeps(key, client) });
    actor.start();
    slots.set(id, actor);
    const subscription = actor.subscribe(() => hearPhase(id, actor));
    watching.set(id, () => subscription.unsubscribe());
    hearPhase(id, actor);
}

/** Stops the chart of a conversation: the connection no longer holds it. */
export function forgetSession(id: string): void {
    useExtensionStore.getState().forgotten(id);
    const actor = slots.get(id);
    if (actor === undefined) return;
    watching.get(id)?.();
    watching.delete(id);
    slots.delete(id);
    actor.stop();
    const next = new Map(phaseMap);
    next.delete(id);
    phaseMap = next;
    notify();
}

/**
 * Keeps the charts in step with the conversations of one connection: one for each, and
 * none for the rest. A connection that holds no conversation - and a window that holds no
 * connection - forgets every chart, because a chart speaks for a process that is gone.
 */
export function syncSessions(keys: readonly SessionKey[], client: QueryClient): void {
    const held = new Set<string>();
    for (const key of keys) {
        held.add(idOf(key));
        ensureSession(key, client);
    }
    for (const id of [...slots.keys()]) {
        if (!held.has(id)) forgetSession(id);
    }
}

/** The chart of a conversation, or `null` while none runs for it. */
export function sessionOf(key: SessionKey): SessionRef | null {
    return slots.get(idOf(key)) ?? null;
}

/** Reads the registry, for a component that shows a conversation or a list of them. */
export function subscribeSessions(read: () => void): () => void {
    readers.add(read);
    return () => {
        readers.delete(read);
    };
}
