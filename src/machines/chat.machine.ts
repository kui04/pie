/**
 * The chat's stages: the landing, a pi on its way, the page that says it could not start,
 * and the session in view.
 *
 * This is the screen's own flow, beside the session's chart (`session.machine.ts`). A
 * session is one pi process with one conversation (`commands/session.rs`): a pick attaches
 * a session on that file, or views the one that already holds it, and the session that was
 * in view is ended when the new one answers - one process at a time, until a milestone keeps
 * several.
 *
 * `attaching` carries what the attempt is for: `path` names the conversation to load (pi
 * reads the file itself), and `dropping` names the session to end when the new one is up.
 * A retry after a failure asks for the same thing again.
 */

import { assign, fromPromise, setup } from "xstate";
import { asPieError, type PieError, type SessionInfo } from "@/lib/bridge";

/** What this machine needs from the outside world. */
export interface ChatDeps {
    /** Starts a pi, on the conversation in `path` when one is named. */
    attach: (path: string | null) => Promise<SessionInfo>;
    /** Ends one pi. The conversation file stays. */
    detach: (session: string) => Promise<void>;
}

/** The stage the chat is in, as the screen and its tests read it. */
export type ChatStage = "landing" | "attaching" | "unattached" | "viewing";

export interface ChatContext {
    deps: ChatDeps;
    /** The session the window shows, or `null` while the landing stands. */
    session: string | null;
    /** What the attempt on its way is for: the file to load, or `null` for a new conversation. */
    path: string | null;
    /** The session the attempt replaces; it is ended when the new one answers. */
    dropping: string | null;
    /** Why the last attempt failed, while the page says so. */
    error: PieError | null;
}

export type ChatEvent =
    /** A new conversation, with no file yet. */
    | { type: "ATTACH" }
    /**
     * A conversation file was chosen. `dropping` names the session to end when it opens;
     * without one, the session in view is the one replaced.
     */
    | { type: "FOCUS"; path: string; dropping?: string | null }
    /** A session that already speaks was chosen. */
    | { type: "OPEN"; session: string }
    /** The screen gives the conversation up: the process ends (`Detach`, not built yet). */
    | { type: "CLOSE" }
    /** The page that says pi could not start asks again. */
    | { type: "RETRY" };

export const chatMachine = setup({
    types: {
        context: {} as ChatContext,
        events: {} as ChatEvent,
        input: {} as ChatDeps,
    },
    actors: {
        attach: fromPromise<SessionInfo, { deps: ChatDeps; path: string | null }>(async ({ input }) =>
            input.deps.attach(input.path),
        ),
    },
    actions: {
        /** What the attempt on its way is for: the file to load, and the session it replaces. */
        pending: assign({
            path: ({ event }) => (event.type === "FOCUS" ? event.path : null),
            dropping: ({ context, event }) =>
                event.type === "FOCUS" ? (event.dropping ?? context.session) : context.session,
            error: null,
        }),
        /** Ends the process the new session replaces, before the new one is written down. */
        dropReplaced: ({ context }) => {
            if (context.dropping !== null) void context.deps.detach(context.dropping);
        },
        /** Ends the session in view, for a close. */
        dropViewed: ({ context }) => {
            if (context.session !== null) void context.deps.detach(context.session);
        },
        /** Writes down the session that was chosen. */
        view: assign({ session: ({ event }) => (event.type === "OPEN" ? event.session : null) }),
    },
}).createMachine({
    id: "chat",
    initial: "landing",
    context: ({ input }) => ({ deps: input, session: null, path: null, dropping: null, error: null }),
    states: {
        landing: {
            on: {
                ATTACH: { target: "attaching", actions: "pending" },
                FOCUS: { target: "attaching", actions: "pending" },
                OPEN: { target: "viewing", actions: "view" },
            },
        },
        // Pi is on its way. No page of the window stands here: every one of them names a
        // session, and this stage is the one that has none.
        attaching: {
            invoke: {
                src: "attach",
                input: ({ context }) => ({ deps: context.deps, path: context.path }),
                onDone: {
                    target: "viewing",
                    actions: [
                        "dropReplaced",
                        assign({
                            session: ({ event }) => event.output.id,
                            path: null,
                            dropping: null,
                            error: null,
                        }),
                    ],
                },
                onError: {
                    target: "unattached",
                    actions: assign({ error: ({ event }) => asPieError(event.error) }),
                },
            },
        },
        // The machine is reached and pi did not start. The page says so and offers the
        // attempt again, on the same conversation.
        unattached: {
            on: {
                RETRY: { target: "attaching", actions: assign({ error: null }) },
            },
        },
        // A conversation is in view. A pick attaches another session on the file, and the
        // one in view is ended when the new one answers.
        viewing: {
            on: {
                ATTACH: { target: "attaching", actions: "pending" },
                FOCUS: { target: "attaching", actions: "pending" },
                OPEN: { target: "viewing", actions: "view" },
                CLOSE: { target: "landing", actions: ["dropViewed", assign({ session: null })] },
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

/** What the attempt on its way loads, or `null` for a new conversation. */
export function pathOf(snapshot: ChatSnapshot): string | null {
    return snapshot.context.path;
}

/** Why pi did not start, or `null`. */
export function errorOf(snapshot: ChatSnapshot): PieError | null {
    return snapshot.context.error;
}
