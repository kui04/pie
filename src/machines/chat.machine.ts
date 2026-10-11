/**
 * The chat's stages: no pi yet, nothing open, one on its way, one shown.
 *
 * This is the screen's own flow, beside the session's chart
 * (`session.machine.ts`): a session's chart owns the feed, the run and the switch
 * of one conversation, while this one owns which conversation the window shows at
 * all. Three stages show the window, and a switch is the same passage as an open:
 * the conversation on screen is given up and the page that says a conversation is
 * coming stands until the answer of the new one arrives.
 *
 * `attaching` comes before them, because a connection is a machine and a session
 * is a pi process: the workspace starts one when it appears. The read of the
 * connection is what says whether it must - Rust holds the process - so the
 * screen sends `ATTACH` or `HELD` from that answer, and the chart waits for both.
 * A `HELD` that arrives first leaves `attaching` before the actor runs, which is
 * the reload whose pi is still speaking: nothing is started twice.
 *
 * `ARRIVED` comes from the session subtree, because only it holds the reads: the
 * feed is live and the snapshot of the conversation has answered. A switch pi
 * refuses or one that fails needs no event of its own - the conversation that
 * stayed is still in the reads, so the same answer arrives for it.
 */

import { assign, fromPromise, setup } from "xstate";
import { asPieError, type PieError } from "@/lib/bridge";

/** What this machine needs from the outside world. */
export interface ChatDeps {
    /**
     * Starts a pi on the connected machine.
     *
     * What it answers is not carried: Rust holds the process, so the session comes
     * back through the read of the connection, and this call is what makes that
     * read stale.
     */
    attach: () => Promise<void>;
}

/** The stage the chat is in, as the screen and its tests read it. */
export type ChatStage = "landing" | "attaching" | "unattached" | "loading" | "loaded";

export interface ChatContext {
    deps: ChatDeps;
    /** The session the window shows, or `null` while it shows the landing. */
    session: string | null;
    /** Why the workspace has no pi to speak through, while the page says so. */
    error: PieError | null;
}

export type ChatEvent =
    /** The read of the connection answered that no pi speaks on it. */
    | { type: "ATTACH" }
    /** The read of the connection shows a session: an attach is not needed. */
    | { type: "HELD" }
    /** A session was chosen on the landing. */
    | { type: "OPEN"; session: string }
    /** Another conversation of the shown session was chosen. */
    | { type: "SWITCH" }
    /** The feed is live and the snapshot of the conversation has answered. */
    | { type: "ARRIVED" }
    /** The screen gave the conversation up (`Detach`, not built yet). */
    | { type: "CLOSE" }
    /** The page that says pi could not be started asks again. */
    | { type: "RETRY" };

export const chatMachine = setup({
    types: {
        context: {} as ChatContext,
        events: {} as ChatEvent,
        input: {} as ChatDeps,
    },
    actors: {
        attach: fromPromise<void, ChatDeps>(async ({ input }) => {
            await input.attach();
        }),
    },
    actions: {
        keep: assign({ session: ({ event }) => (event.type === "OPEN" ? event.session : null) }),
        forget: assign({ session: null }),
    },
}).createMachine({
    id: "chat",
    initial: "landing",
    context: ({ input }) => ({ deps: input, session: null, error: null }),
    states: {
        landing: {
            on: {
                OPEN: { target: "loading", actions: "keep" },
                // Nothing speaks on this connection, so the workspace starts a pi.
                ATTACH: { target: "attaching", actions: "forget" },
            },
        },
        // Pi is on its way. No page of the window stands here: every one of them
        // names a session, and this stage is the one that has none.
        attaching: {
            invoke: {
                src: "attach",
                input: ({ context }) => context.deps,
                onError: { target: "unattached", actions: assign({ error: ({ event }) => asPieError(event.error) }) },
            },
            on: {
                // The attach answered and the read of the connection shows it. The
                // landing takes over, and the window speaks through that session.
                HELD: { target: "landing", actions: "forget" },
            },
        },
        // The machine is reached and no pi runs on it. The page says so and offers
        // the attempt again; a second `ATTACH` from the read changes nothing here.
        unattached: {
            on: {
                RETRY: { target: "attaching", actions: assign({ error: null }) },
            },
        },
        // A conversation is on its way: nothing of it is drawn yet, and the page
        // says so - a feed that never opened says why there instead of guessing at
        // words, and a read that fails leaves the reader where the retry is.
        loading: {
            on: {
                ARRIVED: "loaded",
            },
        },
        // A conversation is on screen. A pick hands the window back to `loading`,
        // which is the same page an open lands on: the words of the one that is
        // leaving are given up at once, and the answer brings the new ones.
        loaded: {
            on: {
                SWITCH: "loading",
                CLOSE: { target: "landing", actions: "forget" },
            },
        },
    },
});

/** The snapshot of this chart, for the readers below. */
export type ChatSnapshot = ReturnType<typeof chatMachine.getInitialSnapshot>;

/** Which of the stages the screen is in. */
export function stageOf(snapshot: ChatSnapshot): ChatStage {
    return snapshot.value as ChatStage;
}

/** The session the window shows, or `null` while it shows the landing. */
export function sessionOf(snapshot: ChatSnapshot): string | null {
    return snapshot.context.session;
}

/** Why the workspace has no pi, or `null` while it has one or is getting one. */
export function errorOf(snapshot: ChatSnapshot): PieError | null {
    return snapshot.context.error;
}
