/**
 * The chat's stages: the landing, a pi on its way, the page that says it could not start,
 * and the session in view.
 *
 * This is the screen's own flow, beside the session's chart (`session.machine.ts`). A session
 * is one pi process with one conversation (`commands/session.rs`): a pick views the session
 * that already holds that file, or attaches another one on it. The sessions that are not in
 * view keep running - their charts follow the connection, not this screen
 * (`lib/sessions.ts`) - and only a close ends one.
 *
 * `attaching` carries what the attempt is for: `path` names the conversation to load (pi
 * reads the file itself), or `cwd` names the directory of a new conversation (`null` for the
 * home of the host). A retry after a failure asks for the same thing again.
 */

import { assign, fromPromise, setup } from "xstate";
import { asPieError, type PieError, type SessionInfo } from "@/lib/bridge";

/** What this machine needs from the outside world. */
export interface ChatDeps {
    /** Starts a pi on the conversation in `path`. */
    attach: (path: string) => Promise<SessionInfo>;
    /** Starts a pi in `cwd` for a new conversation; `null` is the home of the host. */
    start: (cwd: string | null) => Promise<SessionInfo>;
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
    /** The directory of a new conversation, or `null` for the home of the host. */
    cwd: string | null;
    /** Why the last attempt failed, while the page says so. */
    error: PieError | null;
}

export type ChatEvent =
    /** A new conversation, in `cwd` when one is named. */
    | { type: "ATTACH"; cwd: string | null }
    /** A conversation file was chosen: a session of its own, or one that already holds it. */
    | { type: "FOCUS"; path: string }
    /** A session that already speaks was chosen. */
    | { type: "OPEN"; session: string }
    /** The screen gives the conversation up: the process ends. */
    | { type: "CLOSE" }
    /** The page that says pi could not start asks again. */
    | { type: "RETRY" }
    /** The connection that held this session was replaced: the session is gone in Rust, and
     * the screen leaves the conversation behind without ending a process that is already
     * gone. */
    | { type: "GONE" };

export const chatMachine = setup({
    types: {
        context: {} as ChatContext,
        events: {} as ChatEvent,
        input: {} as ChatDeps,
    },
    actors: {
        begin: fromPromise<SessionInfo, { deps: ChatDeps; path: string | null; cwd: string | null }>(
            async ({ input }) => (input.path === null ? input.deps.start(input.cwd) : input.deps.attach(input.path)),
        ),
    },
    actions: {
        /** What the attempt on its way is for: the file to load, or a directory for a new one. */
        pending: assign({
            path: ({ event }) => (event.type === "FOCUS" ? event.path : null),
            cwd: ({ event }) => (event.type === "ATTACH" ? event.cwd : null),
            error: null,
        }),
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
    context: ({ input }) => ({ deps: input, session: null, path: null, cwd: null, error: null }),
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
                src: "begin",
                input: ({ context }) => ({ deps: context.deps, path: context.path, cwd: context.cwd }),
                onDone: {
                    target: "viewing",
                    actions: assign({
                        session: ({ event }) => event.output.id,
                        path: null,
                        cwd: null,
                        error: null,
                    }),
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
        // A conversation is in view. A pick attaches another session on the file that is
        // chosen; the session that was in view keeps running, and the window shows the one
        // that answers. CLOSE is the way one ends.
        viewing: {
            on: {
                ATTACH: { target: "attaching", actions: "pending" },
                FOCUS: { target: "attaching", actions: "pending" },
                OPEN: { target: "viewing", actions: "view" },
                // The session was attached on a connection that is no longer there, and the one
                // that replaced it never held it. Nothing is detached - there is nothing left to
                // detach - and the person is back at the list.
                GONE: { target: "landing", actions: assign({ session: null, path: null, cwd: null, error: null }) },
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
