/**
 * One conversation of pi: what it holds, what it is asked to do, and what it says
 * while it runs.
 *
 * The mirror of `src-tauri/src/commands/session.rs`. A conversation is named by its
 * file on a machine, so every call and every event carries a `HostId` and a path:
 * two machines can hold the same path.
 *
 * A call answers what pi replied to that one ask. An event reports what pi did,
 * whether or not this side asked. So a caller that wants the effect of a model
 * change reads the events, not the answer of the call.
 *
 * The event bus has no replay. A caller attaches its listeners first and reads
 * afterwards, so a missed record is a record the read covers.
 */

import { listen } from "@tauri-apps/api/event";
import type {
    AgentMessage,
    BashResult,
    ClearQueueData,
    CompactionResult,
    EntriesData,
    Event,
    ForkMessage,
    ImageContent,
    Model,
    ModelThinkingLevel,
    PromptData,
    SessionEntry,
    SessionState,
    SessionStats,
    SlashCommand,
    StreamingBehavior,
} from "@/lib/rpc-protocol";
import { onAsk, type AskEnvelope } from "./ask";
import { call, type Unsubscribe } from "./invoke";
import type { HostId } from "./host";

/** How pi queues a message that arrives while the agent streams, and how it reads one back. */
export type QueueMode = "all" | "one-at-a-time";

/** One event of pi's stream, with the conversation it belongs to. */
export interface SessionEvent {
    host: HostId;
    /** The conversation file, as it was attached. */
    session: string;
    /** pi's own record, forwarded verbatim. */
    event: Event;
}

/** How one program ended. */
export type ExitStatus = { type: "exited"; code: number } | { type: "signalled"; signal: number } | { type: "unknown" };

/** The end of the pi process of one conversation. */
export interface SessionEnded {
    host: HostId;
    session: string;
    status: ExitStatus;
}

/**
 * Where one clone left the conversation.
 *
 * pi copies the branch into a new file and serves it. A cancelled clone leaves the
 * conversation on the file the call named.
 */
export type CloneOutcome = { type: "cloned"; session: string } | { type: "cancelled" };

/**
 * Where one fork left the conversation.
 *
 * pi branches the conversation into a new file and serves it. `text` is the user
 * message the branch starts from, which pi leaves out of a fork at the leaf. A
 * cancelled fork leaves the conversation on the file the call named.
 */
export type ForkOutcome = { type: "forked"; session: string; text: string | null } | { type: "cancelled" };

/** One node of a conversation tree. `label` is what a person named the entry. */
export interface SessionTreeNode {
    entry: SessionEntry;
    children: SessionTreeNode[];
    label?: string;
    labelTimestamp?: string;
}

/** A conversation as a tree, with the entry pi shows now. */
export interface SessionTree {
    /** More than one root is possible: navigation can branch, and a broken parent chain roots a node. */
    tree: SessionTreeNode[];
    leafId: string | null;
}

/** What one call to `prompt` did with the message. */
export type PromptDisposition = PromptData["disposition"];

/** The conversation of one conversation, in the order pi holds it. */
export type Messages = AgentMessage[];

/** Stops the run of one conversation. */
export function abort(host: HostId, session: string): Promise<void> {
    return call<void>("abort", { host, session });
}

/** Stops the shell command of one conversation, if one runs. */
export function abortBash(host: HostId, session: string): Promise<void> {
    return call<void>("abort_bash", { host, session });
}

/** Stops the retry pi waits on, if one waits. */
export function abortRetry(host: HostId, session: string): Promise<void> {
    return call<void>("abort_retry", { host, session });
}

/**
 * Runs a shell command on the machine of one conversation, in the directory of
 * that conversation.
 *
 * The command runs through pi, so its result enters the transcript like the result
 * of a tool. While it runs, `bash_execution_update` events stream what it prints.
 * `excludeFromContext` keeps the command and its output out of the model's
 * context.
 */
export function bash(host: HostId, session: string, command: string, excludeFromContext: boolean): Promise<BashResult> {
    return call<BashResult>("bash", { host, session, command, excludeFromContext });
}

/** Drops every queued message of one conversation. The answer names what went. */
export function clearQueue(host: HostId, session: string): Promise<ClearQueueData> {
    return call<ClearQueueData>("clear_queue", { host, session });
}

/**
 * Copies the whole branch of one conversation into a new file, and serves that
 * file.
 *
 * The answer names the file that replaces the one this call named. The old file
 * stays where pi wrote it.
 */
export function cloneSession(host: HostId, session: string): Promise<CloneOutcome> {
    return call<CloneOutcome>("clone_session", { host, session });
}

/**
 * Compacts the conversation of one conversation into a summary, now.
 *
 * `customInstructions` steers the summary. The compaction reports itself on the
 * event channel, so the transcript hears of it whether or not this call asked.
 */
export function compact(host: HostId, session: string, customInstructions?: string): Promise<CompactionResult> {
    return call<CompactionResult>("compact", { host, session, customInstructions });
}

/**
 * Forks one conversation at a user message.
 *
 * The answer names the branched file that replaces the one this call named. The
 * branch is a new conversation, so it runs in a pi of its own.
 */
export function forkSession(host: HostId, session: string, entryId: string): Promise<ForkOutcome> {
    return call<ForkOutcome>("fork_session", { host, session, entryId });
}

/** The models that one conversation can use. */
export function getAvailableModels(host: HostId, session: string): Promise<Model[]> {
    return call<Model[]>("get_available_models", { host, session });
}

/** The thinking levels that one conversation accepts. */
export function getAvailableThinkingLevels(host: HostId, session: string): Promise<ModelThinkingLevel[]> {
    return call<ModelThinkingLevel[]>("get_available_thinking_levels", { host, session });
}

/**
 * The commands that a prompt of one conversation can invoke.
 *
 * The answer holds the commands of the extensions, the prompt templates and the
 * skills of pi. The built-in commands of pi are not in it: this side answers those
 * itself.
 */
export function getCommands(host: HostId, session: string): Promise<SlashCommand[]> {
    return call<SlashCommand[]>("get_commands", { host, session });
}

/**
 * Every entry of one conversation, and the leaf it points at.
 *
 * The answer is the raw set: the other branches of a fork are in it, and the
 * entries that a compaction summarized stay in it. A screen that needs the
 * branches as a tree reads {@link getTree} instead.
 */
export function getEntries(host: HostId, session: string): Promise<EntriesData> {
    return call<EntriesData>("get_entries", { host, session });
}

/** The user messages of one conversation that a fork can start from. */
export function getForkMessages(host: HostId, session: string): Promise<ForkMessage[]> {
    return call<ForkMessage[]>("get_fork_messages", { host, session });
}

/** The text of the last assistant message of one conversation, when there is one. */
export function getLastAssistantText(host: HostId, session: string): Promise<string | null> {
    return call<string | null>("get_last_assistant_text", { host, session });
}

/**
 * The whole conversation of one conversation, in the order pi holds it.
 *
 * This is the read that draws a conversation this side has never seen. A message
 * that this pie does not know travels back as pi wrote it.
 */
export function getMessages(host: HostId, session: string): Promise<Messages> {
    return call<Messages>("get_messages", { host, session });
}

/** The usage of one conversation: counts, tokens, cost, context. */
export function getSessionStats(host: HostId, session: string): Promise<SessionStats> {
    return call<SessionStats>("get_session_stats", { host, session });
}

/**
 * The state of one conversation: its model, its run, its name, its counts.
 *
 * `sessionId` here is pi's id for the conversation. It names no session of pie: the
 * file does.
 */
export function getState(host: HostId, session: string): Promise<SessionState> {
    return call<SessionState>("get_state", { host, session });
}

/** The conversation as a tree, with the entry pi shows now. */
export function getTree(host: HostId, session: string): Promise<SessionTree> {
    return call<SessionTree>("get_tree", { host, session });
}

/**
 * Sends a message to one conversation.
 *
 * `behavior` names how the message joins a run that streams: `steer` interrupts the
 * run at its next step, and `followUp` waits for the run to settle. While nothing
 * streams, pi ignores the behavior and the message starts a run. Therefore a caller
 * does not have to be right about the stream: it names the key that the person
 * pressed, and pi does the rest.
 *
 * `images` are the pictures of the message; pi processes them itself.
 * `attachments` are the paths of staged files; Rust formats them into the message.
 */
export function prompt(
    host: HostId,
    session: string,
    message: string,
    behavior?: StreamingBehavior,
    images?: ImageContent[],
    attachments?: string[],
): Promise<PromptDisposition> {
    return call<PromptDisposition>("prompt", { host, session, message, behavior, images, attachments });
}

/** Turns automatic compaction of one conversation on or off. */
export function setAutoCompaction(host: HostId, session: string, enabled: boolean): Promise<void> {
    return call<void>("set_auto_compaction", { host, session, enabled });
}

/**
 * Lets pi retry a turn that a transient failure ended.
 *
 * pi keeps this setting out of its state, so no call reads it back: the caller that
 * turns it on holds the value.
 */
export function setAutoRetry(host: HostId, session: string, enabled: boolean): Promise<void> {
    return call<void>("set_auto_retry", { host, session, enabled });
}

/**
 * How a follow-up message of one conversation joins the queue.
 *
 * The current mode is readable: it is `followUpMode` of {@link getState}.
 */
export function setFollowUpMode(host: HostId, session: string, mode: QueueMode): Promise<void> {
    return call<void>("set_follow_up_mode", { host, session, mode });
}

/**
 * Selects the model of one conversation and answers the one that is now active.
 *
 * The conversation reports the change as a `model_change` entry and as the model of
 * its state, so a screen reads those rather than this answer.
 */
export function setModel(host: HostId, session: string, provider: string, modelId: string): Promise<Model> {
    return call<Model>("set_model", { host, session, provider, modelId });
}

/** Names one conversation. An empty name falls back to the first prompt. */
export function setSessionName(host: HostId, session: string, name: string): Promise<void> {
    return call<void>("set_session_name", { host, session, name });
}

/**
 * How a message sent mid-run joins the queue of one conversation.
 *
 * The current mode is readable: it is `steeringMode` of {@link getState}.
 */
export function setSteeringMode(host: HostId, session: string, mode: QueueMode): Promise<void> {
    return call<void>("set_steering_mode", { host, session, mode });
}

/** Sets the thinking level of one conversation. */
export function setThinkingLevel(host: HostId, session: string, level: ModelThinkingLevel): Promise<void> {
    return call<void>("set_thinking_level", { host, session, level });
}

/**
 * Listens to the events of every conversation until the returned function is
 * called.
 *
 * One channel carries them all, and each event names its own conversation, so a
 * caller filters on `host` and `session` itself. The stream is not buffered: an
 * event that this side misses is an event that is gone, and a read is the repair.
 */
export function onSessionEvent(onEvent: (event: SessionEvent) => void): Promise<Unsubscribe> {
    return listen<SessionEvent>("pi://session/event", (event) => onEvent(event.payload));
}

/**
 * Listens to the end of every conversation's pi until the returned function is
 * called.
 *
 * The event says that the process ended, not why pie ended it: a caller that asked
 * for a detach recognises its own action, and any other end is a crash or a
 * finished run.
 */
export function onSessionEnded(onEnded: (event: SessionEnded) => void): Promise<Unsubscribe> {
    return listen<SessionEnded>("pi://session/ended", (event) => onEnded(event.payload));
}

// What an extension of pi asks of a person, and what it says without asking.
//
// These live here because they belong to a conversation: `session/extension.rs`
// emits each one for the pi process of one conversation file.

/**
 * One dialog of an extension, as pi asked it.
 *
 * `method` names the dialog, and the fields beside it belong to that method. A
 * method this pie does not know yet is dismissed by id, so a newer pi never stalls
 * on a dialog nobody can draw.
 */
export type UiRequest =
    | { method: "select"; title: string; options: string[]; timeout?: number }
    | { method: "confirm"; title: string; message: string; timeout?: number }
    | { method: "input"; title: string; placeholder?: string; timeout?: number }
    | { method: "editor"; title: string; prefill?: string }
    | { method: "notify"; message: string; notifyType?: string }
    | { method: "setStatus"; statusKey: string; statusText?: string }
    | { method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string }
    | { method: "setTitle"; title: string }
    | { method: "set_editor_text"; text: string }
    | { method: string; [field: string]: unknown };

/** One dialog that waits for the frontend, with the conversation that asked. */
export interface ExtensionAsk {
    host: HostId;
    /** The conversation file of the pi that asked. */
    session: string;
    request: UiRequest;
}

/**
 * The answer to one dialog. `cancelled` dismisses any of them.
 *
 * A select, an input and an editor answer `value`, and a confirm answers
 * `confirmed`.
 */
export type ExtensionAnswer =
    { type: "value"; value: string } | { type: "confirmed"; confirmed: boolean } | { type: "cancelled" };

/** One notice that pi wants a person to see. */
export interface ExtensionNotice {
    host: HostId;
    session: string;
    message: string;
    /** `info`, `warning`, `error`, or a name this pie does not know yet. */
    kind: string;
}

/** One status line of the extension area. `text` of `null` clears the key. */
export interface ExtensionStatus {
    host: HostId;
    session: string;
    key: string;
    text: string | null;
}

/** The window title that pi asked for. */
export interface ExtensionTitle {
    host: HostId;
    session: string;
    title: string;
}

/** The editor text that pi asked for. */
export interface ExtensionEditorText {
    host: HostId;
    session: string;
    text: string;
}

/**
 * Listens to the dialogs of every extension until the returned function is called.
 *
 * The answer goes back through {@link answer} with the id of the envelope.
 */
export function onExtensionAsk(onRequest: (request: AskEnvelope<ExtensionAsk>) => void): Promise<Unsubscribe> {
    return onAsk<ExtensionAsk>("pi://ask/extension", onRequest);
}

/** Listens to the notices of every conversation until the returned function is called. */
export function onExtensionNotice(onNotice: (notice: ExtensionNotice) => void): Promise<Unsubscribe> {
    return listen<ExtensionNotice>("pi://extension/notice", (event) => onNotice(event.payload));
}

/** Listens to the status lines of every conversation until the returned function is called. */
export function onExtensionStatus(onStatus: (status: ExtensionStatus) => void): Promise<Unsubscribe> {
    return listen<ExtensionStatus>("pi://extension/status", (event) => onStatus(event.payload));
}

/** Listens to the titles that extensions ask for until the returned function is called. */
export function onExtensionTitle(onTitle: (title: ExtensionTitle) => void): Promise<Unsubscribe> {
    return listen<ExtensionTitle>("pi://extension/title", (event) => onTitle(event.payload));
}

/** Listens to the editor texts that extensions ask for until the returned function is called. */
export function onExtensionEditorText(onText: (text: ExtensionEditorText) => void): Promise<Unsubscribe> {
    return listen<ExtensionEditorText>("pi://extension/editor", (event) => onText(event.payload));
}
