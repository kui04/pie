/**
 * The connection lifecycle: nothing to reach, reaching, reached, or the reason
 * it did not happen.
 *
 * The one thing worth reading here is the shape of `connecting`. Rust holds the
 * `connect` command open across the whole handshake, and part of that handshake
 * is a *question for a person*: a host key that is in no known_hosts store
 * cannot be answered by the machine. So `asking` is a child of `connecting`
 * rather than a flag beside it — a question can only exist while a handshake is
 * in flight, and saying so in the graph means a screen cannot read
 * `connecting && asking` out of two places and get it wrong.
 *
 * The handshake is one actor that subscribes *and* dials, in that order. The
 * host-key question arrives on the event channel while `connect` is still
 * pending, so a listener registered after the dial started would have missed
 * exactly the event it exists to catch.
 *
 * Which bridge the actors call comes in as the machine's input, so the tests and
 * the stories walk this graph end to end without a Tauri runtime.
 */

import { assign, fromCallback, fromPromise, setup } from "xstate";
import type { ConnectionInfo, ConnectSpec, PresentedKey } from "@/lib/bridge";
import * as bridge from "@/lib/bridge";

/** What this machine needs from the outside world. */
export interface ConnectionDeps {
    /** The name the connection is opened under, and its events arrive on. */
    connection: string;
    connect: typeof bridge.connect;
    trustHostKey: typeof bridge.trustHostKey;
    onConnectionState: typeof bridge.onConnectionState;
}

export interface ConnectionContext {
    deps: ConnectionDeps;
    /** What was asked for, read by the handshake when `connecting` is entered. */
    spec: ConnectSpec | null;
    /** What `connect` answered with, once it has. */
    info: ConnectionInfo | null;
    /** Why the last attempt failed, while the failure is on screen. */
    error: bridge.PieError | null;
    /** The key being asked about, while the question is on screen. */
    hostKey: PresentedKey | null;
    /** What was just answered, on its way to Rust. */
    trusted: boolean;
}

export type ConnectionEvent =
    | { type: "CONNECT"; spec: ConnectSpec }
    | { type: "DISMISS" }
    /** A host presented a key that is in no store. */
    | { type: "HOST_KEY"; key: PresentedKey }
    | { type: "ANSWER_HOST_KEY"; trusted: boolean }
    | { type: "CONNECTED"; info: ConnectionInfo }
    | { type: "FAILED"; error: bridge.PieError };

export const connectionMachine = setup({
    types: {
        context: {} as ConnectionContext,
        events: {} as ConnectionEvent,
        input: {} as ConnectionDeps,
    },
    actors: {
        handshake: fromCallback<ConnectionEvent, { deps: ConnectionDeps; spec: ConnectSpec }>(({ input, sendBack }) => {
            let unlisten: bridge.Unsubscribe | undefined;
            // Set when the machine left `connecting` underneath this actor:
            // the listener then has to be dropped as soon as it arrives, and
            // nothing may be reported to a graph that has moved on.
            let stopped = false;

            void (async () => {
                // Subscribing is inside the try for the same reason dialling is:
                // without a listener the host-key question would go unheard, so a
                // listener that never arrives is a failed handshake and has to
                // read as one. Reporting only the dial would leave the form
                // locked on "Connecting" with nothing left to unlock it.
                try {
                    unlisten = await input.deps.onConnectionState(input.deps.connection, (state) => {
                        if (state.type === "host_key") sendBack({ type: "HOST_KEY", key: state.key });
                    });
                    if (stopped) {
                        unlisten();
                        return;
                    }
                    const info = await input.deps.connect(input.deps.connection, input.spec);
                    sendBack({ type: "CONNECTED", info });
                } catch (thrown) {
                    unlisten?.();
                    sendBack({ type: "FAILED", error: bridge.asPieError(thrown) });
                }
            })();

            return () => {
                stopped = true;
                unlisten?.();
            };
        }),
        trust: fromPromise<void, { deps: ConnectionDeps; trusted: boolean }>(async ({ input }) => {
            await input.deps.trustHostKey(input.deps.connection, input.trusted);
        }),
    },
}).createMachine({
    id: "connection",
    initial: "idle",
    context: ({ input }) => ({ deps: input, spec: null, info: null, error: null, hostKey: null, trusted: false }),
    states: {
        idle: {
            on: {
                CONNECT: {
                    target: "connecting",
                    // The spec is read back out of context by the handshake:
                    // an `invoke` sees every event that can reach the state, so
                    // the one that opened it is not the one it is typed against.
                    actions: assign({ spec: ({ event }) => event.spec, error: null }),
                },
            },
        },
        connecting: {
            initial: "waiting",
            invoke: {
                src: "handshake",
                input: ({ context }) => ({ deps: context.deps, spec: context.spec as ConnectSpec }),
            },
            on: {
                // Handled on the parent so it lands the same way whether or not
                // a question is already on screen: Rust keeps one question open
                // at a time, and the one it replaces arrives as a new event.
                HOST_KEY: { target: ".asking", actions: assign({ hostKey: ({ event }) => event.key }) },
                CONNECTED: { target: "connected", actions: assign({ info: ({ event }) => event.info, hostKey: null }) },
                // `hostKey` is cleared here as it is on every other way out of
                // `connecting`: the prompt is open exactly while a question is,
                // and a question cannot outlive the handshake that raised it. Left
                // set, the prompt stays open over the error, and since
                // `ANSWER_HOST_KEY` is only handled in `asking` there is nothing
                // left that can close it — cancel, trust, Escape and dragging the
                // sheet down all send an event the machine drops.
                FAILED: { target: "error", actions: assign({ error: ({ event }) => event.error, hostKey: null }) },
            },
            states: {
                waiting: {},
                asking: {
                    // The question is on screen. Answering drops it and moves to
                    // `answering` rather than ending anything: the handshake is
                    // still running, and it is that handshake which decides what
                    // the answer bought.
                    on: {
                        ANSWER_HOST_KEY: {
                            target: "answering",
                            actions: assign({ hostKey: null, trusted: ({ event }) => event.trusted }),
                        },
                    },
                },
                answering: {
                    invoke: {
                        src: "trust",
                        input: ({ context }) => ({ deps: context.deps, trusted: context.trusted }),
                        // Both outcomes go back to waiting. The answer being
                        // undeliverable is not the handshake's ending — it is one
                        // step of it failing to report — and the handshake is what
                        // knows how it ends. Without this the rejected actor is
                        // dropped and the machine stays here for good: the prompt
                        // is already gone and the form is locked, so no event can
                        // reach it again.
                        onDone: { target: "waiting" },
                        onError: { target: "waiting" },
                    },
                },
            },
        },
        error: {
            on: {
                CONNECT: {
                    target: "connecting",
                    actions: assign({ spec: ({ event }) => event.spec, error: null }),
                },
                DISMISS: { target: "idle", actions: assign({ error: null, hostKey: null }) },
            },
        },
        connected: {},
    },
});
