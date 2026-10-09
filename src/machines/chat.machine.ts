/**
 * The chat's stages: nothing open, one on its way, one shown.
 *
 * This is the screen's own flow, beside the session's chart
 * (`session.machine.ts`): a session's chart owns the feed, the run and the switch
 * of one conversation, while this one owns which conversation the window shows at
 * all. Three stages, three pages of the window, and a switch is the same passage
 * as an open: the conversation on screen is given up and the page that says a
 * conversation is coming stands until the answer of the new one arrives.
 *
 * `ARRIVED` comes from the session subtree, because only it holds the reads: the
 * feed is live and the snapshot of the conversation has answered. A switch pi
 * refuses or one that fails needs no event of its own - the conversation that
 * stayed is still in the reads, so the same answer arrives for it.
 */

import { assign, setup } from "xstate";

/** The stage the chat is in, as the screen and its tests read it. */
export type ChatStage = "landing" | "loading" | "loaded";

export interface ChatContext {
    /** The session the window shows, or `null` while it shows the landing. */
    session: string | null;
}

export type ChatEvent =
    /** A session was chosen on the landing. */
    | { type: "OPEN"; session: string }
    /** Another conversation of the shown session was chosen. */
    | { type: "SWITCH" }
    /** The feed is live and the snapshot of the conversation has answered. */
    | { type: "ARRIVED" }
    /** The screen gave the conversation up (`Detach`, not built yet). */
    | { type: "CLOSE" };

export const chatMachine = setup({
    types: { context: {} as ChatContext, events: {} as ChatEvent },
    actions: {
        keep: assign({ session: ({ event }) => (event.type === "OPEN" ? event.session : null) }),
        forget: assign({ session: null }),
    },
}).createMachine({
    id: "chat",
    initial: "landing",
    context: { session: null },
    states: {
        landing: {
            on: {
                OPEN: { target: "loading", actions: "keep" },
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
