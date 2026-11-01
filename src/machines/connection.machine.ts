/**
 * The connection lifecycle: no connection, a connection in progress, one that is ready,
 * and the reason that one failed.
 *
 * A failure is held in the context of the `error` state and announced by the screen that
 * asked for the dial (`notify`), which leaves the form ready for another attempt. The
 * machine draws nothing and announces nothing on its own.
 *
 * `asking` is a child of `connecting`, not a flag: a host-key question can exist only while
 * a handshake is active, and the graph shows that in one place.
 *
 * The handshake subscribes first, then dials. The question arrives on the ask channel while
 * `connect` is still pending, and it carries the id that the answer goes back under.
 *
 * The bridge comes in as input, so tests and stories walk this graph without a Tauri runtime.
 */

import { assign, fromCallback, fromPromise, setup } from "xstate";
import type { HostTarget, PieError, TrustAsk } from "@/lib/bridge";
import * as bridge from "@/lib/bridge";

/** One host-key question, with the id it is answered under. */
export interface TrustQuestion {
    id: number;
    ask: TrustAsk;
}

/** What this machine needs from the outside world. */
export interface ConnectionDeps {
    connection: string;
    connect: typeof bridge.connect;
    answer: typeof bridge.answer;
    onTrustAsk: typeof bridge.onTrustAsk;
    /** A dial that failed. The screen owns the stack the sentence lands in. */
    notify: (failure: PieError) => void;
    onHostKey: (question: TrustQuestion | null) => void;
}

export interface ConnectionContext {
    deps: ConnectionDeps;
    spec: HostTarget | null;
    error: PieError | null;
    /** The id of the question on screen, while one is. */
    question: number | null;
    trusted: boolean;
}

export type ConnectionEvent =
    | { type: "CONNECT"; spec: HostTarget }
    | { type: "HOST_KEY"; question: TrustQuestion }
    | { type: "ANSWER_HOST_KEY"; trusted: boolean }
    | { type: "CONNECTED" }
    | { type: "FAILED"; error: PieError };

export const connectionMachine = setup({
    types: {
        context: {} as ConnectionContext,
        events: {} as ConnectionEvent,
        input: {} as ConnectionDeps,
    },
    actors: {
        handshake: fromCallback<ConnectionEvent, { deps: ConnectionDeps; spec: HostTarget }>(({ input, sendBack }) => {
            let unlisten: bridge.Unsubscribe | undefined;
            // The machine left `connecting` below this actor. Drop the listener as soon as it
            // arrives, rather than reporting to a graph that moved on.
            let stopped = false;

            void (async () => {
                // Subscribe inside the try, as for the dial: a listener that does not arrive
                // is a failed handshake, and the form would otherwise stay locked on
                // "Connecting".
                try {
                    unlisten = await input.deps.onTrustAsk((envelope) => {
                        if (envelope.payload.host !== input.deps.connection) return;
                        sendBack({ type: "HOST_KEY", question: { id: envelope.id, ask: envelope.payload } });
                    });
                    if (stopped) {
                        unlisten();
                        return;
                    }
                    // The answer of the dial is not carried: Rust holds the connection, and the
                    // workspace reads it back with the connection read.
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
        trust: fromPromise<void, { deps: ConnectionDeps; id: number; trusted: boolean }>(async ({ input }) => {
            const data: bridge.TrustAnswer = input.trusted ? { type: "trusted" } : { type: "refused" };
            await input.deps.answer(input.id, { status: "resolved", data });
        }),
    },
}).createMachine({
    id: "connection",
    initial: "idle",
    context: ({ input }) => ({ deps: input, spec: null, error: null, question: null, trusted: false }),
    states: {
        idle: {
            on: {
                CONNECT: {
                    target: "connecting",
                    // The handshake reads the spec from the context: `invoke` sees every event
                    // that can reach the state, not only the one that opened it.
                    actions: assign({ spec: ({ event }) => event.spec, error: null }),
                },
            },
        },
        connecting: {
            initial: "waiting",
            invoke: {
                src: "handshake",
                input: ({ context }) => ({ deps: context.deps, spec: context.spec as HostTarget }),
            },
            exit: ({ context }) => context.deps.onHostKey(null),
            on: {
                // On the parent, so a question arrives the same way with or without one on
                // screen. Rust keeps one question open at a time.
                HOST_KEY: {
                    target: ".asking",
                    actions: [
                        assign({ question: ({ event }) => event.question.id }),
                        ({ context, event }) => context.deps.onHostKey(event.question),
                    ],
                },
                CONNECTED: {
                    target: "connected",
                    // The answer stays in Rust, which holds the connection.
                },
                FAILED: {
                    target: "error",
                    actions: assign({ error: ({ event }) => event.error }),
                },
            },
            states: {
                waiting: {},
                asking: {
                    // Answering removes the question and moves to `answering`. The handshake
                    // continues, and it decides the result of the answer.
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
                        input: ({ context }) => ({
                            deps: context.deps,
                            id: context.question as number,
                            trusted: context.trusted,
                        }),
                        // Both results go back to `waiting`: an undeliverable answer is one step
                        // that does not report, and the handshake still knows its end. Without
                        // this transition the rejected actor is dropped and the machine stays.
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
