/**
 * The run of one session: whether an answer streams from pi right now.
 *
 * This state is what a render cannot answer: the key of the composer stops a run
 * instead of sending, and Enter steers one instead of starting it. The events of a
 * run say when it begins and ends; a read of the state says it for a screen that
 * mounted in the middle of a run, or whose listeners were closed for a while.
 *
 * A read is never authoritative over an event: its answer was built before the
 * event arrived, and it may reach this machine after it. Therefore a run event
 * marks the state as heard, and a read that arrives after one is dropped.
 * `LISTENING` clears the mark when the listeners open again, because the records
 * of a closed listener are gone and only a read covers them.
 *
 * The machine has no actors: pi does the work, and the composer sends it the key
 * the person pressed. A run that ends with `willRetry` stays working — pi goes on
 * by itself, and `agent_settled` is what says it stopped.
 */

import { assign, setup } from "xstate";

export interface SessionContext {
    /** A run event has been heard since the listeners last opened. */
    heardRun: boolean;
}

export type SessionEvent =
    /** The listeners of the session are open; only a read covers the time before. */
    | { type: "LISTENING" }
    /** The state of the session was read; `streaming` is its `isStreaming`. */
    | { type: "STATE_READ"; streaming: boolean }
    /** `agent_start`: a run began. */
    | { type: "RUN_STARTED" }
    /** `agent_end`: the run ended; `willRetry` says pi goes on by itself. */
    | { type: "RUN_ENDED"; willRetry: boolean }
    /** `agent_settled`: the run is over and pi is idle. */
    | { type: "SETTLED" };

export const sessionMachine = setup({
    types: {
        context: {} as SessionContext,
        events: {} as SessionEvent,
    },
}).createMachine({
    id: "session",
    initial: "idle",
    context: { heardRun: false },
    on: {
        // A re-open says that only a read covers the records that a closed
        // listener missed. It is not a run event.
        LISTENING: { actions: assign({ heardRun: false }) },
    },
    states: {
        idle: {
            on: {
                RUN_STARTED: { target: "working", actions: assign({ heardRun: true }) },
                STATE_READ: [
                    {
                        guard: ({ context, event }) => !context.heardRun && event.streaming,
                        target: "working",
                        actions: assign({ heardRun: true }),
                    },
                    { actions: assign({ heardRun: true }) },
                ],
                RUN_ENDED: { actions: assign({ heardRun: true }) },
                SETTLED: { actions: assign({ heardRun: true }) },
            },
        },
        working: {
            on: {
                // A run that began while this machine was idle, and a second
                // `agent_start` of a run it already knows: both stay here.
                RUN_STARTED: { actions: assign({ heardRun: true }) },
                STATE_READ: [
                    {
                        guard: ({ context, event }) => !context.heardRun && !event.streaming,
                        target: "idle",
                        actions: assign({ heardRun: true }),
                    },
                    { actions: assign({ heardRun: true }) },
                ],
                RUN_ENDED: [
                    {
                        guard: ({ event }) => !event.willRetry,
                        target: "idle",
                        actions: assign({ heardRun: true }),
                    },
                    { actions: assign({ heardRun: true }) },
                ],
                SETTLED: { target: "idle", actions: assign({ heardRun: true }) },
            },
        },
    },
});
