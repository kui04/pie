/**
 * A session of pi: the conversations of the machine, what one session holds, and
 * what it says while it runs.
 *
 * The mirror of `src-tauri/src/commands/session.rs` — one session is asked to
 * read, to switch, and to speak — plus the events of `commands/pipe.rs`, which
 * carry what pi says.
 *
 * A session is named by the id that `attachSession` answered with — pie's id for
 * the process, which is the id its events arrive under. That is not the id of
 * pi's session file: the same process moves between those (see `switchSession`).
 *
 * A dialog of an extension and a failure of an extension have channels of their
 * own, and nothing consumes them yet (that belongs to the extension milestone). A
 * record that Rust cannot describe is not forwarded at all.
 *
 * A listener must exist before the records it wants: the event bus has no replay,
 * and Rust sends an event only to a window that already listens for its name.
 * Therefore a caller subscribes first and reads afterwards (see
 * `hooks/use-session.ts`), which is what makes a missed record a record that the
 * snapshot covers.
 *
 * A command here ends in one of three ways, and none of them needs a report
 * through this layer: pi answers with a disposition, a queue, a result, or
 * nothing, and every lasting change reports itself as an event of the session.
 * A caller that wants the effect of a model change or a compaction watches the
 * events, not the answer of the call.
 *
 * The types are hand-written mirrors of Rust: `SessionSummary` of
 * `session::SessionSummary`, the lifecycle of `commands/pipe.rs`, the payloads of
 * the commands below of the session layer, and the aliases of pi's own published
 * types from `@/lib/rpc-protocol`. Rust is the authority.
 */

import { listen } from "@tauri-apps/api/event";
import type {
    AvailableModelsData,
    AvailableThinkingLevelsData,
    BashResult,
    ClearQueueData,
    CommandsData,
    CompactionResult,
    EntriesData,
    Event,
    ImageContent,
    LastAssistantTextData,
    Model,
    ModelThinkingLevel,
    PromptData,
    SessionState,
    SessionStats,
    StreamingBehavior,
    SwitchSessionData,
} from "@/lib/rpc-protocol";
import { call, type Unsubscribe } from "./invoke";
import type { SessionInfo } from "./host";
// The sessions of the host. These are files, not protocol: pie scans the sessions
// directory itself, on this machine or over sftp, because pi has no command that
// lists its sessions.

/** One session that pi wrote, as its own lines report it. */
export interface SessionSummary {
    /** The place of the file, as the host sees it. */
    path: string;
    /** The id of the session from pi, from the header of the file. */
    id: string;
    /** Where the session started. Empty for files that are older than this field of pi. */
    cwd: string;
    /** The display name that the user gave last, if present. */
    name?: string | null;
    /** The session of the fork, if this session is a fork. */
    parentSessionPath?: string | null;
    /** The start time of the session by pi, RFC3339. */
    created: string;
    /** The time of the last growth of the file, RFC3339. */
    modified: string;
    /** The first words of the user, if the file goes that far. */
    firstMessage?: string | null;
}

/**
 * Every session on the connected host, most recently written first.
 *
 * A session that has said nothing yet has no file, and therefore no row: pi
 * writes one at the start of the first turn (its `#10000` rule).
 */
export function listSessions(): Promise<SessionSummary[]> {
    return call<SessionSummary[]>("list_sessions");
}

/**
 * Starts a pi on the connected machine, and answers with the session it speaks
 * through.
 *
 * The connection itself runs no pi: reaching the machine and speaking on it are
 * two different things, and only the second one needs a process. The id of the
 * answer is pie's own for that process (`main:1`), and it is what every other
 * function here names, and what the events arrive under.
 */
export function attachSession(): Promise<SessionInfo> {
    return call<SessionInfo>("attach_session");
}

/**
 * Ends one pi. The machine stays reached, and the conversation file stays where
 * pi wrote it.
 *
 * Pi winds down: pie closes its standard input, waits for the process to stop,
 * and kills it only when it does not. A session that is gone is a failure
 * (`unknown_session`), because a caller that asks to end something twice holds a
 * stale id.
 */
export function detachSession(session: string): Promise<void> {
    return call<void>("detach_session", { session });
}

// One session, by the name of it.

/**
 * The state of one session: its model, its run, its name, its counts.
 *
 * `sessionId` here is the id of pi's session file, which is what tells one
 * conversation of a process from another (see `switchSession`).
 */
export function getState(session: string): Promise<SessionState> {
    return call<SessionState>("get_state", { session });
}

/**
 * Every entry of one session, and the leaf it points at.
 *
 * The answer is the raw set: the other branches of a fork are in it, and the
 * entries that a compaction summarized stay in it. The view of the transcript is
 * built from it on this side (see `stores/transcript.store.ts`).
 */
export function getEntries(session: string): Promise<EntriesData> {
    return call<EntriesData>("get_entries", { session });
}

/** The usage of one session: its counts, its tokens, its cost, its context. */
export function getSessionStats(session: string): Promise<SessionStats> {
    return call<SessionStats>("get_session_stats", { session });
}

/**
 * Makes a session continue the conversation of a session file.
 *
 * `path` is the `path` of a row that {@link listSessions} answered with (the
 * frontend builds none of them: pi opens a path that holds no file as a new
 * conversation in its own directory). The pi process keeps running; the
 * conversation it holds does not. No event announces the change, so the caller
 * reads the transcript again — `cancelled` says that an extension of pi refused
 * the switch, and then nothing changed at all.
 */
export function switchSession(session: string, path: string): Promise<SwitchSessionData> {
    return call<SwitchSessionData>("switch_session", { session, path });
}

// What pi says about a running session, as it says it.

/** How the pi of a session ended. */
export type Termination =
    { type: "exited"; code: number; success: boolean } | { type: "signalled"; signal: number } | { type: "unknown" };

/** What the frontend hears about the life of a session. */
export type SessionLifecycle = {
    type: "ended";
    /** How the process ended; `success` separates an orderly end from a crash. */
    termination: Termination;
};

/** One event of a session, on `pi://session/{id}/event`. */
export function onSessionEvent(session: string, onEvent: (event: Event) => void): Promise<Unsubscribe> {
    return listen<Event>(`pi://session/${session}/event`, (event) => onEvent(event.payload));
}

/** The end of a session. No record of that session follows. */
export function onSessionState(session: string, onState: (state: SessionLifecycle) => void): Promise<Unsubscribe> {
    return listen<SessionLifecycle>(`pi://session/${session}/state`, (event) => onState(event.payload));
}

/**
 * Sends a message to one session.
 *
 * `behavior` names how the message joins a run that streams: `steer` interrupts
 * the run at its next step, and `followUp` waits for the run to settle. While
 * nothing streams, pi ignores the behavior and the message starts a run.
 * Therefore a caller does not have to be right about the stream: it names the key
 * that the person pressed, and pi does the rest.
 *
 * The answer says what happened: `started`, `queued`, or `handled` for a message
 * that a command of an extension took without a run.
 *
 * `images` are the pictures of the message, as `pick.ts` answered them; pi
 * processes them itself.
 */
export function prompt(
    session: string,
    message: string,
    behavior?: StreamingBehavior,
    images?: ImageContent[],
): Promise<PromptData> {
    return call<PromptData>("prompt", { session, message, behavior, images });
}

/** Stops the run of one session, and a compaction in progress with it. */
export function abort(session: string): Promise<void> {
    return call<void>("abort", { session });
}

/**
 * Drops every queued message of one session.
 *
 * The protocol has no way to take back a single message: this drops the steering
 * queue and the follow-up queue together (G7 of the plan). The answer names what
 * went, so a screen can say it.
 */
export function clearQueue(session: string): Promise<ClearQueueData> {
    return call<ClearQueueData>("clear_queue", { session });
}

/**
 * Runs a shell command on the host of one session, in the directory of that
 * session.
 *
 * The command runs through pi, so its result enters the transcript like the
 * result of a tool. While it runs, `bash_execution_update` events stream what it
 * prints. `excludeFromContext` keeps the command and its output out of the
 * context of the model — the `!!` form of the composer.
 */
export function bash(session: string, command: string, excludeFromContext: boolean): Promise<BashResult> {
    return call<BashResult>("bash", { session, command, excludeFromContext });
}

/** Stops the shell command of one session, if one runs. */
export function abortBash(session: string): Promise<void> {
    return call<void>("abort_bash", { session });
}

/**
 * The commands that a prompt of one session can invoke.
 *
 * The answer holds the commands of the extensions, the prompt templates and the
 * skills of pi. The built-in commands of pi are not in it: the frontend answers
 * those itself.
 */
export function getCommands(session: string): Promise<CommandsData> {
    return call<CommandsData>("get_commands", { session });
}

/** The models that one session can use. */
export function getAvailableModels(session: string): Promise<AvailableModelsData> {
    return call<AvailableModelsData>("get_available_models", { session });
}

/** The thinking levels that one session accepts. */
export function getAvailableThinkingLevels(session: string): Promise<AvailableThinkingLevelsData> {
    return call<AvailableThinkingLevelsData>("get_available_thinking_levels", { session });
}

/**
 * Selects the model of one session and answers the one that is now active.
 *
 * The session reports the change as a `model_change` entry and as the model of
 * its state; the caller reads those rather than this answer.
 */
export function setModel(session: string, provider: string, modelId: string): Promise<Model> {
    return call<Model>("set_model", { session, provider, modelId });
}

/** Sets the thinking level of one session. */
export function setThinkingLevel(session: string, level: ModelThinkingLevel): Promise<void> {
    return call<void>("set_thinking_level", { session, level });
}

/** Turns automatic compaction of one session on or off. */
export function setAutoCompaction(session: string, enabled: boolean): Promise<void> {
    return call<void>("set_auto_compaction", { session, enabled });
}

/**
 * Compacts the conversation of one session into a summary, now.
 *
 * `customInstructions` steers the summary. Compaction reports itself on the event
 * channel of the session, so the transcript hears of it whether or not this call
 * is the one that asked.
 */
export function compact(session: string, customInstructions?: string): Promise<CompactionResult> {
    return call<CompactionResult>("compact", { session, customInstructions });
}

/** The text of the last assistant message of one session, when there is one. */
export function getLastAssistantText(session: string): Promise<LastAssistantTextData> {
    return call<LastAssistantTextData>("get_last_assistant_text", { session });
}

/** Names one session. */
export function setSessionName(session: string, name: string): Promise<void> {
    return call<void>("set_session_name", { session, name });
}
