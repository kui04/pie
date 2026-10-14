/**
 * Whether pie still has its connection, and what happens while a person brings it back.
 *
 * A connection ends on its own. The network goes away, the host sleeps, the window closes
 * its lid - and no command need be in flight when that happens, so the app cannot learn it
 * from a failed read: a read fails late, and only where it was read. Rust watches the reach
 * to the machine and says so (`ConnectionState::Ended`), and this machine is what answers it.
 *
 * This is not a session. A lost connection stops every pi on the machine, and the sessions
 * the frontend knows are forgotten with the connection that held them. Nothing here
 * attaches, detaches or re-reads a conversation: bringing the connection back is one thing,
 * opening a conversation on it is another.
 *
 * `left` is where a person has gone to the gate. The overlay is theirs to dismiss, and the
 * connection stays lost until a dial answers. A connection read that completes after that - the
 * retry below, or a dial on the gate - is what brings the state back to `held`.
 *
 * The bridge comes in as input. Therefore tests walk this graph with no Tauri runtime.
 */

import { assign, fromPromise, setup } from "xstate";
import * as bridge from "@/lib/bridge";

/** Where the reach to the machine stands, for the screen that answers it. */
export type ConnectionWatchState = "held" | "lost" | "retrying" | "failed" | "left";

/**
 * What the surface of a lost connection stands over: the states in which pie cannot speak to the
 * machine and a person has been given nothing else to look at. `held` is the app at work, and
 * `left` is a person already at the gate - the surface is theirs to dismiss.
 */
export const ON_SCREEN: readonly ConnectionWatchState[] = ["lost", "retrying", "failed"];

/** What this machine needs from the outside world. */
export interface ConnectionWatchDeps {
    /**
     * Dials the machine again with what Rust holds (`bridge.reconnect`), and reads the
     * connection back. It answers when a live connection is held, so the machine's `held`
     * means it.
     */
    reconnect: () => Promise<void>;
}

export interface ConnectionWatchContext {
    deps: ConnectionWatchDeps;
    /** When the end of the connection was heard, on the clock of a read's `dataUpdatedAt`. */
    lostAt: number;
    /** What a dial that failed said, or `null` while nothing has failed. */
    message: string | null;
}

export type ConnectionWatchEvent =
    /** The connection ended. */
    | { type: "LOST"; at: number }
    /** A person asked for the machine again. */
    | { type: "RETRY" }
    /** A connection read completed: the machine answered after the end was heard. */
    | { type: "RESTORED"; at: number }
    /** A person left for the gate. */
    | { type: "LEAVE" };

type RestoredEvent = Extract<ConnectionWatchEvent, { type: "RESTORED" }>;

export const connectionWatchMachine = setup({
    types: {
        context: {} as ConnectionWatchContext,
        events: {} as ConnectionWatchEvent,
        input: {} as ConnectionWatchDeps,
    },
    actors: {
        reconnect: fromPromise<void, ConnectionWatchDeps>(async ({ input }) => {
            await input.reconnect();
        }),
    },
    guards: {
        /**
         * Whether an answer arrived after the end of the connection was heard. A read that
         * completed before it belongs to the connection that ended, and cannot bring
         * anything back.
         */
        answeredAfterTheEnd: ({ context, event }) => (event as RestoredEvent).at > context.lostAt,
    },
}).createMachine({
    id: "connection-watch",
    initial: "held",
    context: ({ input }) => ({ deps: input, lostAt: 0, message: null }),
    // One place for the reach coming back: an answer that completed after the end was heard is the
    // truth, whether the person was waiting, dialling, reading a failure or at the gate. The
    // target is a child of this node, and XState reads a rooted name as a sibling of the machine.
    on: {
        RESTORED: { target: ".held", guard: "answeredAfterTheEnd" },
    },
    states: {
        /** Pie holds a connection, and the reach to its machine answers. */
        held: {
            on: {
                LOST: {
                    target: "lost",
                    actions: assign({
                        lostAt: ({ event }) => event.at,
                        message: null,
                    }),
                },
            },
        },
        /** The reach is gone, and nobody has been asked what to do about it yet. */
        lost: {
            on: {
                RETRY: "retrying",
                LEAVE: "left",
            },
        },
        /** A person asked for the machine again, and the dial is in flight. */
        retrying: {
            invoke: {
                src: "reconnect",
                input: ({ context }) => context.deps,
                onDone: {
                    target: "held",
                    actions: assign({ message: null }),
                },
                onError: {
                    target: "failed",
                    actions: assign({ message: ({ event }) => reasonOf(event.error) }),
                },
            },
            // A person may leave while the dial runs. The dial still finishes, and the
            // connection it brings back still counts.
            on: {
                LEAVE: "left",
            },
        },
        /** The dial failed. The reason is on screen, and Reconnect stays available. */
        failed: {
            on: {
                RETRY: "retrying",
                LEAVE: "left",
            },
        },
        /** A person is at the gate. The overlay is not theirs to see again until a dial
         * answers, whichever dial it was. */
        left: {},
    },
});

/** The sentence of a failed dial, as the boundary reports it. */
function reasonOf(thrown: unknown): string {
    return bridge.asPieError(thrown).message;
}
