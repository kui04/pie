/**
 * The connection lifecycle. The states are: no connection, a connection in
 * progress, a connection that is ready, and the reason that the connection
 * failed.
 *
 * A failure is held in the context of the `error` state and announced by the
 * screen that asked for the dial (`notify`), which leaves the form ready for
 * another attempt. The machine draws nothing and announces nothing on its own.
 *
 * `asking` is a child of `connecting`. It is not a flag. A host-key question can
 * exist only while a handshake is active. The graph shows this condition in one
 * place.
 *
 * The handshake subscribes first. Then it dials. The question arrives on the
 * event channel while `connect` is still pending.
 *
 * The bridge comes in as input. Therefore tests and stories walk this graph
 * without a Tauri runtime.
 */

import { assign, fromCallback, fromPromise, setup } from "xstate";
import type { ConnectSpec, PieError, PresentedKey } from "@/lib/bridge";
import * as bridge from "@/lib/bridge";

/** What this machine needs from the outside world. */
export interface ConnectionDeps {
    connection: string;
    connect: typeof bridge.connect;
    trustHostKey: typeof bridge.trustHostKey;
    onConnectionState: typeof bridge.onConnectionState;
    /** A dial that failed. The screen owns the stack the sentence lands in. */
    notify: (failure: PieError) => void;
    onHostKey: (key: PresentedKey | null) => void;
}

export interface ConnectionContext {
    deps: ConnectionDeps;
    spec: ConnectSpec | null;
    error: bridge.PieError | null;
    trusted: boolean;
}

export type ConnectionEvent =
    | { type: "CONNECT"; spec: ConnectSpec }
    | { type: "HOST_KEY"; key: PresentedKey }
    | { type: "ANSWER_HOST_KEY"; trusted: boolean }
    | { type: "CONNECTED" }
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
            // The machine left `connecting` below this actor. Drop the listener
            // as soon as it arrives. Do not report to a graph that moved on.
            let stopped = false;

            void (async () => {
                // Subscribe inside the try, as for the dial. Without the
                // listener, the host-key question goes unheard. A listener that
                // does not arrive is a failed handshake. If only the dial
                // reports, the form stays locked on "Connecting".
                try {
                    unlisten = await input.deps.onConnectionState(input.deps.connection, (state) => {
                        if (state.type === "host_key") sendBack({ type: "HOST_KEY", key: state.key });
                    });
                    if (stopped) {
                        unlisten();
                        return;
                    }
                    // What the connect answered is not carried: Rust holds the
                    // connection, and the workspace reads it back with
                    // `get_connection` (`lib/query/index.ts`).
                    await input.deps.connect(input.deps.connection, input.spec);
                    sendBack({ type: "CONNECTED" });
                } catch (thrown) {
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
    context: ({ input }) => ({ deps: input, spec: null, error: null, trusted: false }),
    states: {
        idle: {
            on: {
                CONNECT: {
                    target: "connecting",
                    // The handshake reads the spec from the context. `invoke`
                    // sees all events that can reach the state. It does not see
                    // only the event that opened the state.
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
            exit: ({ context }) => context.deps.onHostKey(null),
            on: {
                // This transition is on the parent. Therefore a question arrives
                // in the same way with or without a question on screen. Rust
                // keeps one question open at a time.
                HOST_KEY: {
                    target: ".asking",
                    actions: ({ context, event }) => context.deps.onHostKey(event.key),
                },
                CONNECTED: {
                    target: "connected",
                    // The answer stays in Rust, which holds the connection. The
                    // workspace reads it back with `get_connection`.
                },
                FAILED: {
                    target: "error",
                    actions: assign({ error: ({ event }) => event.error }),
                },
            },
            states: {
                waiting: {},
                asking: {
                    // Answering removes the question and moves to `answering`. The
                    // handshake continues. The handshake decides the result of
                    // the answer.
                    on: {
                        ANSWER_HOST_KEY: {
                            target: "answering",
                            actions: [
                                ({ context }) => context.deps.onHostKey(null),
                                assign({ trusted: ({ event }) => event.trusted }),
                            ],
                        },
                    },
                },
                answering: {
                    invoke: {
                        src: "trust",
                        input: ({ context }) => ({ deps: context.deps, trusted: context.trusted }),
                        // Both results go back to `waiting`. An undeliverable
                        // answer is one step that does not report. The handshake
                        // still knows its end. Without this transition, the
                        // rejected actor is dropped and the machine stays here.
                        onDone: { target: "waiting" },
                        onError: { target: "waiting" },
                    },
                },
            },
        },
        error: {
            entry: ({ context }) => {
                if (context.error !== null) context.deps.notify(context.error);
            },
            on: {
                CONNECT: {
                    target: "connecting",
                    actions: assign({ spec: ({ event }) => event.spec, error: null }),
                },
            },
        },
        connected: {},
    },
});
