/**
 * The chat's stages: nothing open, one on its way, one shown.
 *
 * This is the screen's own flow, beside the session's chart
 * (`session.machine.ts`): a session's chart owns the feed, the run and the switch
 * of one conversation, while this one owns which conversation the window shows at
 * all. The window draws its landing while nothing is chosen, and the loading of a
 * conversation happens between the pick and the entries that answer it.
 *
 * Two of the events come from the session subtree, because only it holds the
 * reads: `ARRIVED` when the feed is live and the snapshot answered, `FAILED` when
 * the feed itself could not open. A failed open stays where the reader can say
 * another try (`failed`), while a failed switch returns to the conversation that
 * was on screen, which is still the one pi holds.
 */

import { assign, setup } from "xstate";

/** The stage the chat is in, as the screen and its tests read it. */
export type ChatStage = "landing" | "opening" | "switching" | "loaded" | "failed";

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
    /** The feed could not open. */
    | { type: "FAILED" }
    /** The reader asks for the feed of the failed session again. */
    | { type: "RETRY" }
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
                OPEN: { target: "opening", actions: "keep" },
            },
        },
        // The conversation of the landing is opened: nothing of it is drawn yet, and
        // a feed that never opens says so here rather than guessing at words.
        opening: {
            on: {
                ARRIVED: "loaded",
                FAILED: "failed",
            },
        },
        // The feed of a chosen session never opened. The window says what happened
        // and offers another try, because nothing of that session is on screen: the
        // readers of the list are held, so the way out is the retry or the gate.
        failed: {
            on: {
                RETRY: "opening",
                CLOSE: { target: "landing", actions: "forget" },
            },
        },
        // A pick while a conversation is shown: the previous one stays the one pi
        // holds until pi answers, so a failure returns to it rather than to the
        // landing.
        switching: {
            on: {
                ARRIVED: "loaded",
                FAILED: "loaded",
            },
        },
        loaded: {
            on: {
                SWITCH: "switching",
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
