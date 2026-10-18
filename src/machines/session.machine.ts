/**
 * The feed of one session, its transcript, and the phase of the run. The three are
 * independent, so they are three regions of one chart (`.agents/rules/state.md`):
 *
 * - `feed`: `opening` (the listeners stand in the way), `live`, `failed`.
 * - `transcript`: `empty` until a base read answered, then `ready`. The base stays in
 *   Query; the overlay of `lib/transcript-merge.ts` is the context of this chart.
 * - `run`: `idle`, `waiting` (from the send until the model's first output), `working`.
 *
 * A session is one pi process with one conversation: it never changes its conversation, so
 * there is no switch and no fence. A pick of another conversation attaches another session
 * (the chat chart).
 *
 * A region cannot read its siblings, so the transition that must know whether the feed is
 * attached is raised by the region that knows: `STATE_READ` becomes `READ` in `live` (a read
 * of a session nobody is attached to cannot move the phase).
 *
 * A read never outranks a record either: its answer was formed before the records that
 * arrived after it was asked for. The run region holds a read authority for that:
 * `readAuthoritative` is open until a phase record is heard, and `lastReadAt` is the
 * `dataUpdatedAt` of the last applied answer. Only `begin`, `write` and `end` records close
 * it - a delta says nothing about the phase, so it may not. While the authority is open the
 * newest answer applies; it opens again when the listeners open, or when the pipe reports a
 * gap in the records, because the records of a closed listener are gone and only a read
 * covers them.
 *
 * Everything the chart needs from the world comes through `deps`, so a test drives this
 * graph with a stub feed and needs no Tauri runtime.
 */

import { assign, fromCallback, raise, setup, type SnapshotFrom } from "xstate";
import * as bridge from "@/lib/bridge";
import type { EntriesData, Event as SessionRecord } from "@/lib/rpc-protocol";
import { noticeOf, reading, type Notice, type ReadTarget } from "@/lib/session-records";
import type { RunPhase } from "@/lib/stream";
import {
    acceptEntry,
    acceptSnapshot,
    emptyStream,
    liveDelta,
    liveEnd,
    liveRetrying,
    liveStart,
    liveToolEnd,
    liveToolStart,
    liveToolUpdate,
    noQueue,
    type StreamState,
} from "@/lib/transcript-merge";

export interface SessionDeps {
    /** Opens the two subscriptions of the session - both, or none. */
    listen: (
        onRecord: (record: SessionRecord) => void,
        onLifecycle: (life: bridge.SessionLifecycle) => void,
    ) => Promise<bridge.Unsubscribe>;
    /** Asks one read of this session again. */
    reRead: (target: ReadTarget) => void;
    /** Says what a retry is doing. */
    notice: (notice: Notice) => void;
}

export interface SessionContext extends StreamState {
    deps: SessionDeps;
    /** Why the listeners could not be opened, while the screen says so. */
    error: bridge.PieError | null;
    /** A read may set the phase: no phase record has been heard since the authority opened. */
    readAuthoritative: boolean;
    /** The `dataUpdatedAt` of the last applied state read: a late older answer may not move the phase. */
    lastReadAt: number;
    /**
     * When this side heard that the response of a run is in the session file, or `null` while
     * no response waits for a read.
     */
    settledAt: number | null;
    /** The `dataUpdatedAt` of the last accepted base: an older answer may not replace it. */
    lastSnapshotAt: number;
    /** The attempt the last scheduled summarization retry named, for the words of the one that runs. */
    summaryAt: { attempt: number; maxAttempts: number } | null;
}

export type SessionEvent =
    /** Both listeners are open; only a read covers the time before them. */
    | { type: "FEED_OPEN"; at: number }
    /** The listeners could not be opened. */
    | { type: "FEED_FAILED"; error: bridge.PieError }
    /** The pi of this session is gone: its reads have to be asked again. */
    | { type: "FEED_STALE" }
    /** The pipe fell behind: records were dropped, and the reads are the repair. */
    | { type: "GAP"; at: number }
    /**
     * The conversation of this session was replaced in the process: pi forked or cloned,
     * and the same process now holds another file. Everything of the old conversation
     * goes, and the reads are asked again.
     */
    | { type: "REPLACED" }
    /**
     * One record of the session, as the wire carries it. `at` is the moment this side heard
     * it, on the same clock as a read's `dataUpdatedAt`: it orders a settle against the reads,
     * and it travels in the event because an action that read the clock itself would write a
     * different context for the same event, which a graph walk of this chart cannot dedupe.
     */
    | { type: "RECORD"; record: SessionRecord; at: number }
    /** The state of the session was read; `streaming` is its `isStreaming`, `at` its `dataUpdatedAt`. */
    | { type: "STATE_READ"; streaming: boolean; at: number }
    /** The entries of the session were read, with the leaf they point at. */
    | { type: "SNAPSHOT"; data: EntriesData; at: number }
    /** The usage of the session was read; `at` is its `dataUpdatedAt`. */
    | { type: "STATS_READ"; at: number }
    /** Ask for the listeners again, for a screen whose failure was the subscription. */
    | { type: "REOPEN" }
    /** Raised inside the chart by `live`: the feed is attached, so a read may move the phase. */
    | { type: "READ"; streaming: boolean; at: number }
    /** The reader's own shell command: the card that runs above the composer. */
    | { type: "BASH_START"; run: { command: string; excludeFromContext: boolean } }
    /** The command never ran: the card goes without an entry to take it down. */
    | { type: "BASH_DROPPED" };

/** The record of a `RECORD` event, for the actions that read it. */
type RecordEvent = Extract<SessionEvent, { type: "RECORD" }>;

/** The answer of a base read, for the actions and guards that read it. */
type SnapshotEvent = Extract<SessionEvent, { type: "SNAPSHOT" }>;

/** A read of the usage, and a shell command of the reader. */
type StatsEvent = Extract<SessionEvent, { type: "STATS_READ" }>;
type BashEvent = Extract<SessionEvent, { type: "BASH_START" }>;

/** The two events that reset the clock of the reads, for the actions that read it. */
type FeedOpenEvent = Extract<SessionEvent, { type: "FEED_OPEN" }>;
type GapEvent = Extract<SessionEvent, { type: "GAP" }>;

/** Whether a state answer may set the phase: the authority is open and the answer is newer. */
function readApplies(context: SessionContext, at: number): boolean {
    return context.readAuthoritative && at > context.lastReadAt;
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
        const at = Date.now();
        for (const record of batch) sendBack({ type: "RECORD", record, at });
    };

    // Deltas arrive tens of times a second and each one folds the rows again, so they
    // wait for a frame; anything else goes after the deltas before it, which is the order
    // pi wrote them in (a call's arguments may not be read before its text).
    const hear = (record: SessionRecord) => {
        if (record.type !== "message_update") {
            flush();
            sendBack({ type: "RECORD", record, at: Date.now() });
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
            const events = await deps.listen(hear, (life) => {
                // The deltas held for their frame go first: a gap may not overtake a record
                // that arrived before it, and the order of what this side hears is the order
                // pi wrote it in.
                flush();
                // The end of the session fails the reads; a gap in its records makes them the
                // authority again. Either way the feed itself is unchanged: the pipe is alive.
                sendBack(life.type === "lagged" ? { type: "GAP", at: Date.now() } : { type: "FEED_STALE" });
            });
            // The chart left this state before the listeners arrived: drop them rather
            // than feeding a graph that moved on.
            if (!alive) {
                events();
                return;
            }
            off = [events];
            sendBack({ type: "FEED_OPEN", at: Date.now() });
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
    actions: {
        /**
         * The listeners are open: the queue goes (records alone write it), and the reads are
         * asked again. The clock travels in the event, so that the same event always writes
         * the same context: an action that called `Date.now()` itself would stamp a fresh
         * value, and a graph walk of this chart would never meet a node it had seen.
         */
        opened: assign(({ event }) => ({
            error: null,
            readAuthoritative: true,
            lastReadAt: (event as FeedOpenEvent).at,
            queued: noQueue,
        })),
        /** Asks every read of this session again, after a gap in the records. */
        reReadWhole: ({ context }) => context.deps.reRead("whole"),
        /**
         * The conversation was replaced in the process (a fork or a clone). The session is the
         * same process, but everything this side holds belongs to the conversation that is gone:
         * the overlay, the live rows, the queue, the shell card, the usage, and the names of the
         * rows. The base read goes back to "not yet", and the reads that are asked again fill it
         * with the new conversation.
         */
        replaced: assign(() => ({
            ...emptyStream(),
            readAuthoritative: true,
            lastReadAt: 0,
            lastSnapshotAt: 0,
            settledAt: null,
            summaryAt: null,
        })),
        /**
         * A gap in the records: a read may set the phase again, and the queue goes - it is
         * written by records alone, and the ones this gap swallowed are gone.
         */
        gap: assign(({ event }) => ({
            readAuthoritative: true,
            lastReadAt: (event as GapEvent).at,
            queued: noQueue,
        })),
        /**
         * The pi of this session is gone: nothing a run left behind may be shown - no settle
         * record is coming for it - and the reads have to say so.
         */
        stale: assign({ usage: null, settledAt: null }),
        /**
         * What a record leaves in the context: the response it settled, and the summary retry
         * it scheduled. The settle is held as the record's own moment, and a read that cannot
         * cover the response leaves it where it is (A1), so the read that does cover it takes
         * the increment and this time away together.
         */
        mark: assign(({ event }) => {
            const { record, at } = event as RecordEvent;
            const spec = reading(record);
            const settled = spec.settles === true ? { settledAt: at } : {};
            const notice = spec.notice;
            if (notice === undefined) return settled;
            if (notice.kind === "summary-scheduled") {
                return { ...settled, summaryAt: { attempt: notice.attempt, maxAttempts: notice.maxAttempts } };
            }
            if (notice.kind === "summary-finished") return { ...settled, summaryAt: null };
            return settled;
        }),
        /** What a record says out loud, and the reads it makes stale - either way, drawn or not. */
        route: ({ context, event }) => {
            const spec = reading((event as RecordEvent).record);
            if (spec.notice !== undefined) {
                const words = noticeOf(spec.notice, context.summaryAt);
                if (words !== null) context.deps.notice(words);
            }
            for (const target of spec.invalidates) context.deps.reRead(target);
        },
        /**
         * Writes what a record carries, while the feed is live. The answer of a read that
         * lands mid-run takes the rows over (`acceptSnapshot`).
         */
        draw: assign(({ context, event, self }) => {
            // The value is read as the plain object a snapshot is: `@xstate/graph` walks the
            // machine with a scope whose snapshot carries none.
            const here = self.getSnapshot?.().value as { feed?: string } | undefined;
            if (here?.feed !== "live") return {};
            const spec = reading((event as RecordEvent).record);
            if (spec.draws === null) return {};
            switch (spec.draws.kind) {
                case "liveStart":
                    return liveStart(context, spec.draws.message);
                case "liveDelta":
                    // The increment carries the clock of the record that wrote it, so that a
                    // settle and a stats answer are ordered against it on one timeline.
                    return liveDelta(context, spec.draws.event, spec.draws.usage, (event as RecordEvent).at);
                case "liveEnd":
                    return liveEnd(context, spec.draws.message);
                case "toolStart":
                    return liveToolStart(context, spec.draws);
                case "toolUpdate":
                    return liveToolUpdate(context, spec.draws);
                case "toolEnd":
                    return liveToolEnd(context, spec.draws);
                case "retrying":
                    return liveRetrying(context);
                case "entry":
                    return acceptEntry(context, spec.draws.entry);
                case "queue":
                    return { queued: { steering: [...spec.draws.steering], followUp: [...spec.draws.followUp] } };
                case "bash":
                    return context.bash === null
                        ? {}
                        : { bash: { ...context.bash, output: context.bash.output + spec.draws.delta } };
            }
        }),
        /** A phase record was heard: the phase is the records' from here, not a read's. */
        runHeard: assign({ readAuthoritative: false }),
        /** The base read answered: the stream is reconciled with it. */
        snapshot: assign(({ context, event }) => {
            const { data, at } = event as SnapshotEvent;
            return { ...acceptSnapshot(context, data), lastSnapshotAt: at };
        }),
        /**
         * A stats answer that covers the settled response is the truth now, so the increment
         * and the settle time go with it (C4). An answer written before the settle may not
         * drop the increment - the response may not be in the file yet - and it leaves the
         * settle time where it is, for the read that does cover it (A1). An answer older than
         * the increment itself covers nothing either.
         */
        statsRead: assign(({ context, event }) => {
            const { at } = event as StatsEvent;
            if (context.settledAt === null) return {};
            if (context.usage !== null && at < context.usage.at) return {};
            return at >= context.settledAt ? { usage: null, settledAt: null } : {};
        }),
        /** The reader's own shell command: the card that runs above the composer. */
        bashStart: assign({ bash: ({ event }) => ({ ...(event as BashEvent).run, output: "" }) }),
        /** The command never ran: the card goes without an entry to take it down. */
        bashDropped: assign({ bash: null }),
    },
}).createMachine({
    id: "session",
    type: "parallel",
    context: ({ input }) => ({
        ...emptyStream(),
        deps: input,
        error: null,
        readAuthoritative: false,
        lastReadAt: 0,
        lastSnapshotAt: 0,
        settledAt: null,
        summaryAt: null,
    }),
    on: {
        BASH_START: { actions: "bashStart" },
        BASH_DROPPED: { actions: "bashDropped" },
        STATS_READ: { actions: "statsRead" },
    },
    states: {
        feed: {
            initial: "opening",
            // The listeners belong to `feed` and to no state inside it: a read moves
            // `opening` to `live`, a failure to `failed`, and neither may drop them.
            invoke: { id: "listen", src: "listen", input: ({ context }) => ({ deps: context.deps }) },
            // A reopen enters `opening` again, which restarts the actor. What the run drew
            // and the phase it holds are not reset: those rows are the run's still, the
            // deltas that keep arriving land in them, and the read that follows settles the
            // phase (the authority opens again below).
            on: {
                REOPEN: {
                    target: ".opening",
                    reenter: true,
                    // The authority opens with the FEED_OPEN that follows: only then is a
                    // fresh read the cover for the records of the closed listener.
                    actions: assign({ error: null }),
                },
                // The pi of this session went away: every read of it is stale, and what the
                // run left on screen goes with it.
                FEED_STALE: { actions: ["stale", "reReadWhole"] },
            },
            states: {
                opening: {
                    on: {
                        FEED_OPEN: {
                            target: "live",
                            // Only now may this session be read, and only a read covers the
                            // records a closed listener missed: the reads are asked again.
                            actions: ["opened", "reReadWhole"],
                        },
                        FEED_FAILED: {
                            target: "failed",
                            actions: assign({ error: ({ event }) => event.error }),
                        },
                    },
                },
                live: {
                    on: {
                        // Raised to the region that holds the phase: a read is reachable
                        // only from an attached feed.
                        STATE_READ: {
                            actions: raise(({ event }) => ({
                                type: "READ",
                                streaming: event.streaming,
                                at: event.at,
                            })),
                        },
                        // The pipe of this session fell behind and records were dropped, so
                        // what a read says outranks what was heard: the authority opens, every
                        // read is asked again, and the queue goes. The transcript and the run
                        // stay on screen - the reader is looking at them, and the base read
                        // supersedes them as its answer lands. A gap reported while the
                        // listeners are still opening is not lost: the open that follows resets
                        // the same three things.
                        GAP: { actions: ["gap", "reReadWhole"] },
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
        transcript: {
            initial: "empty",
            on: {
                // The conversation of this session was replaced in the process (a fork or a
                // clone). The base in hand is the conversation that is gone, so the region goes
                // back to "not yet", and the reads that are asked again bring the new one.
                REPLACED: { target: ".empty", actions: ["replaced", "reReadWhole"] },
            },
            states: {
                // No base read has answered for this conversation yet.
                empty: {
                    on: {
                        SNAPSHOT: {
                            target: "ready",
                            // `>=`: two answers in one millisecond tie, and the one that arrived
                            // last is the one that was read last.
                            guard: ({ context, event }) => (event as SnapshotEvent).at >= context.lastSnapshotAt,
                            actions: "snapshot",
                        },
                    },
                },
                // The base is in view; a later answer refreshes it.
                ready: {
                    on: {
                        SNAPSHOT: {
                            target: "ready",
                            guard: ({ context, event }) => (event as SnapshotEvent).at >= context.lastSnapshotAt,
                            actions: "snapshot",
                        },
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
                REPLACED: { target: ".idle" },
                READ: [
                    {
                        guard: ({ context, event }) => readApplies(context, event.at) && event.streaming,
                        target: ".working",
                        actions: assign({ lastReadAt: ({ event }) => event.at }),
                    },
                    {
                        guard: ({ context, event }) => readApplies(context, event.at) && !event.streaming,
                        target: ".idle",
                        actions: assign({ lastReadAt: ({ event }) => event.at }),
                    },
                    // A read older than a heard phase record changes nothing. It does not
                    // latch either: a later read may still settle the phase.
                    { actions: [] },
                ],
                RECORD: [
                    {
                        guard: ({ event }) => reading(event.record).run === "begin",
                        target: ".waiting",
                        actions: ["mark", "route", "draw", "runHeard"],
                    },
                    {
                        guard: ({ event }) => reading(event.record).run === "write",
                        target: ".working",
                        actions: ["mark", "route", "draw", "runHeard"],
                    },
                    {
                        guard: ({ event }) => reading(event.record).run === "end",
                        target: ".idle",
                        actions: ["mark", "route", "draw", "runHeard"],
                    },
                    {
                        // A delta, a queue update, an entry: nothing about the phase.
                        actions: ["mark", "route", "draw"],
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

/** Whether the feed holds a subscription: the reads may run. */
export function isListening(snapshot: SessionSnapshot): boolean {
    return snapshot.matches({ feed: "live" });
}

/** Whether a base read of the conversation has answered. */
export function isReady(snapshot: SessionSnapshot): boolean {
    return snapshot.matches({ transcript: "ready" });
}

/** Why the listeners could not be opened, or `null`. */
export function errorOf(snapshot: SessionSnapshot): bridge.PieError | null {
    return snapshot.context.error;
}
