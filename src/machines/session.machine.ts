/**
 * The feed of one session, the switch that may be in flight, and the phase of the run.
 * The three are independent, so they are three regions of one chart
 * (`.agents/rules/state.md`):
 *
 * - `feed`: `opening` (the listeners stand in the way), `live`, `failed`.
 * - `switching`: `off` or `inFlight`. A switch does not close the listeners, and the
 *   phase of the run being left must stay readable (the composer's key is `working`).
 * - `run`: `idle`, `waiting` (from the send until the model's first output), `working`.
 *   The bytes of a run are the store's; a phase is not a question about the rows, because
 *   a read that lands mid-run takes the rows over.
 *
 * A region cannot read its siblings, so the two transitions that must know whether the
 * feed is attached are raised by the region that knows: `SWITCH` becomes `BEGIN_SWITCH`
 * in `live` (a screen that never attached has no conversation to leave), and `STATE_READ`
 * becomes `READ` there (a read of a session nobody is attached to cannot move the phase).
 *
 * A read never outranks a record either: its answer was formed before the records that
 * arrived after it was asked for. The first record of a run closes `heardRun` and a read
 * that follows may only latch; opening the listeners again opens the latch, because the
 * records of a closed listener are gone and only a read covers them.
 *
 * The listeners live in an actor, so the race where a subscription arrives after its
 * state was left is handled here (`connection.machine.ts` does the same for the
 * handshake). Everything the chart needs from the world comes through `deps`, so a test
 * drives this graph with a stub feed and needs no Tauri runtime.
 */

import { assign, fromCallback, raise, setup, type SnapshotFrom } from "xstate";
import * as bridge from "@/lib/bridge";
import type { Event as SessionRecord } from "@/lib/protocol";
import type { RecordTable } from "@/lib/session-records";
import type { RunPhase } from "@/lib/stream";

export interface SessionDeps {
    /** Applies one record: the store, the reads it makes stale, the words (`lib/session-records.ts`). */
    apply: RecordTable["apply"];
    /** Opens the two subscriptions of the session - both, or none. */
    listen: (onRecord: (record: SessionRecord) => void, onStale: () => void) => Promise<bridge.Unsubscribe>;
    /** Continues this session as the conversation in `path`. */
    switchSession: (path: string) => Promise<{ cancelled: boolean }>;
    /** Asks the reads of this session again. */
    reRead: () => void;
    /** The listeners are open: the queue goes, because records alone write it. */
    opened: () => void;
    /** Empties what the conversation being left owned, and asks both of its reads again. */
    afterSwitch: () => void;
}

export interface SessionContext {
    deps: SessionDeps;
    /** Why the listeners could not be opened, while the screen says so. */
    error: bridge.PieError | null;
    /** A record of a run has been heard since the listeners last opened. */
    heardRun: boolean;
}

export type SessionEvent =
    /** Both listeners are open; only a read covers the time before them. */
    | { type: "FEED_OPEN" }
    /** The listeners could not be opened. */
    | { type: "FEED_FAILED"; error: bridge.PieError }
    /** The pi of this session is gone: its reads have to be asked again. */
    | { type: "FEED_STALE" }
    /** One record of the session, as the wire carries it. */
    | { type: "RECORD"; record: SessionRecord }
    /** The state of the session was read; `streaming` is its `isStreaming`. */
    | { type: "STATE_READ"; streaming: boolean }
    /** Ask for the listeners again, for a screen whose failure was the subscription. */
    | { type: "REOPEN" }
    /** A switch of this session is on its way: its rows may belong to the conversation being left. */
    | { type: "SWITCH" }
    /** The switch is done: the conversation in view is another one. */
    | { type: "SWITCH_DONE" }
    /** Pi refused the switch, or it failed: the conversation in view is the same one. */
    | { type: "SWITCH_ABANDONED" }
    | { type: "SWITCH_FAILED" }
    /** Raised inside the chart by `live`: the feed is attached, so a switch may begin. */
    | { type: "BEGIN_SWITCH" }
    /** Raised inside the chart by `live`: the feed is attached, so a read may move the phase. */
    | { type: "READ"; streaming: boolean }
    /** Raised inside the chart by a done switch: the run before it is over. */
    | { type: "NEW_CONVERSATION" };

/** A run began: `agent_start`, or the message a reader sent while pi was idle. */
function beginsRun(record: SessionRecord): boolean {
    return record.type === "agent_start" || (record.type === "message_start" && record.message.role === "user");
}

/** The model has begun to write the answer of the run. */
function writesAnswer(record: SessionRecord): boolean {
    return record.type === "message_start" && record.message.role === "assistant";
}

/** The run is over. `agent_end` keeps it alive while pi takes the turn up again. */
function endsRun(record: SessionRecord): boolean {
    return record.type === "agent_settled" || (record.type === "agent_end" && !record.willRetry);
}

/**
 * Applies what a record carries, and says whether it may draw: the rows of a
 * conversation are written only while that conversation is the one in view.
 */
function draw(context: SessionContext, record: SessionRecord, self: Reader): void {
    // Read as the plain object the state is: naming the snapshot type here would make
    // this signature depend on the machine that uses it, and the machine's on this one.
    const here = self.getSnapshot().value as { feed?: string; switching?: string };
    context.deps.apply(record, here.feed === "live" && here.switching === "off");
}

/** A reader of the chart's own state, for the action above. */
interface Reader {
    getSnapshot: () => { value: unknown };
}

/** The feed of the session the actor is subscribed to. */
const listen = fromCallback<SessionEvent, { deps: SessionDeps }>(({ input, sendBack }) => {
    const { deps } = input;
    let alive = true;
    let off: bridge.Unsubscribe[] = [];
    let frame: number | null = null;
    /** The deltas of one frame, held so that the answer folds once for all of them. */
    let held: SessionRecord[] = [];

    const flush = () => {
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        const batch = held;
        held = [];
        for (const record of batch) sendBack({ type: "RECORD", record });
    };

    // Deltas arrive tens of times a second and each one folds the rows again, so they
    // wait for a frame; anything else goes after the deltas before it, which is the order
    // pi wrote them in (a call's arguments may not be read before its text).
    const hear = (record: SessionRecord) => {
        if (record.type !== "message_update") {
            flush();
            sendBack({ type: "RECORD", record });
            return;
        }
        held.push(record);
        frame ??= requestAnimationFrame(() => {
            frame = null;
            flush();
        });
    };

    void (async () => {
        try {
            const events = await deps.listen(hear, () => sendBack({ type: "FEED_STALE" }));
            // The chart left this state before the listeners arrived: drop them rather
            // than feeding a graph that moved on.
            if (!alive) {
                events();
                return;
            }
            off = [events];
            sendBack({ type: "FEED_OPEN" });
        } catch (thrown) {
            for (const unsubscribe of off) unsubscribe();
            off = [];
            if (alive) sendBack({ type: "FEED_FAILED", error: bridge.asPieError(thrown) });
        }
    })();

    return () => {
        alive = false;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        held = [];
        for (const unsubscribe of off) unsubscribe();
        off = [];
    };
});

export const sessionMachine = setup({
    types: {
        context: {} as SessionContext,
        events: {} as SessionEvent,
        input: {} as SessionDeps,
    },
    actors: { listen },
}).createMachine({
    id: "session",
    type: "parallel",
    context: ({ input }) => ({ deps: input, error: null, heardRun: false }),
    states: {
        feed: {
            initial: "opening",
            // The listeners belong to `feed` and to no state inside it: a read moves
            // `opening` to `live`, a failure to `failed`, and neither may drop them.
            invoke: { id: "listen", src: "listen", input: ({ context }) => ({ deps: context.deps }) },
            // A reopen enters `opening` again, which restarts the actor. What the run drew
            // and the phase it holds are not reset: those rows are the run's still, the
            // deltas that keep arriving land in them, and the read that follows settles the
            // phase (its latch is open again below).
            on: {
                REOPEN: {
                    target: ".opening",
                    reenter: true,
                    actions: assign({ error: null, heardRun: false }),
                },
                // The pi of this session went away: every read of it is stale.
                FEED_STALE: { actions: ({ context }) => context.deps.reRead() },
            },
            states: {
                opening: {
                    on: {
                        FEED_OPEN: {
                            target: "live",
                            // Only now may this session be read, and only a read covers the
                            // records a closed listener missed: the reads are asked again.
                            actions: [
                                assign({ heardRun: false }),
                                assign({ error: null }),
                                ({ context }) => {
                                    context.deps.opened();
                                    context.deps.reRead();
                                },
                            ],
                        },
                        FEED_FAILED: {
                            target: "failed",
                            actions: assign({ error: ({ event }) => event.error }),
                        },
                    },
                },
                live: {
                    on: {
                        // Raised to the regions that hold the switch and the phase: both are
                        // reachable only from an attached feed.
                        SWITCH: { actions: raise({ type: "BEGIN_SWITCH" }) },
                        STATE_READ: { actions: raise(({ event }) => ({ type: "READ", streaming: event.streaming })) },
                    },
                },
                failed: {
                    on: {
                        // A later attempt that fails too replaces the reason on screen.
                        FEED_FAILED: { actions: assign({ error: ({ event }) => event.error }) },
                    },
                },
            },
        },
        switching: {
            initial: "off",
            states: {
                off: {
                    // Raised by `live`: reachable only on an attached feed.
                    on: { BEGIN_SWITCH: { target: "inFlight" } },
                },
                inFlight: {
                    on: {
                        // Another conversation is in view, and pi aborted the run of the one
                        // being left (`teardownCurrent` of `agent-session-runtime.ts`): the
                        // phase starts over and the reads are asked again.
                        SWITCH_DONE: {
                            target: "off",
                            actions: [
                                assign({ heardRun: false }),
                                ({ context }) => context.deps.afterSwitch(),
                                raise({ type: "NEW_CONVERSATION" }),
                            ],
                        },
                        // Pi refused the switch, or it failed: the same conversation is in view
                        // and its run never stopped, so nothing else changes.
                        SWITCH_ABANDONED: { target: "off" },
                        SWITCH_FAILED: { target: "off" },
                    },
                },
            },
        },
        run: {
            initial: "idle",
            states: {
                idle: {},
                waiting: {},
                working: {},
            },
            on: {
                // The conversation the run belonged to is gone.
                NEW_CONVERSATION: { target: ".idle" },
                READ: [
                    {
                        guard: ({ context, event }) => !context.heardRun && event.streaming,
                        target: ".working",
                        actions: assign({ heardRun: true }),
                    },
                    {
                        guard: ({ context, event }) => !context.heardRun && !event.streaming,
                        target: ".idle",
                        actions: assign({ heardRun: true }),
                    },
                    { actions: assign({ heardRun: true }) },
                ],
                RECORD: [
                    {
                        guard: ({ event }) => beginsRun(event.record),
                        target: ".waiting",
                        actions: [
                            ({ context, event, self }) => draw(context, event.record, self),
                            assign({ heardRun: true }),
                        ],
                    },
                    {
                        guard: ({ event }) => writesAnswer(event.record),
                        target: ".working",
                        actions: [
                            ({ context, event, self }) => draw(context, event.record, self),
                            assign({ heardRun: true }),
                        ],
                    },
                    {
                        guard: ({ event }) => endsRun(event.record),
                        target: ".idle",
                        actions: [
                            ({ context, event, self }) => draw(context, event.record, self),
                            assign({ heardRun: true }),
                        ],
                    },
                    {
                        actions: [
                            ({ context, event, self }) => draw(context, event.record, self),
                            assign({ heardRun: true }),
                        ],
                    },
                ],
            },
        },
    },
});

/** The snapshot of this chart, for the readers below. */
export type SessionSnapshot = SnapshotFrom<typeof sessionMachine>;

/** The phase of the run this session is in, as the transcript and the composer read it. */
export function phaseOf(snapshot: SessionSnapshot): RunPhase {
    return snapshot.matches({ run: "working" }) ? "working" : snapshot.matches({ run: "waiting" }) ? "waiting" : "idle";
}

/** Whether the feed holds a subscription: the reads may run, and a switch may begin. */
export function isListening(snapshot: SessionSnapshot): boolean {
    return snapshot.matches({ feed: "live" });
}

/** Whether a conversation is being left. */
export function isSwitching(snapshot: SessionSnapshot): boolean {
    return snapshot.matches({ switching: "inFlight" });
}
