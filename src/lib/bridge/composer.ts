/**
 * What the frontend says to a session: a message, an interrupt, a shell command,
 * and the controls that surround them.
 *
 * These are the commands of the composer, the mirror of `commands/composer.rs`.
 * The session is named as `session.ts` names it: pie's id for the pi process
 * (`main:1`), which is what its events arrive under.
 *
 * A command here ends in one of three ways, and none of them needs a report
 * through this layer: pi answers with a disposition, a queue, a result, or
 * nothing, and every lasting change reports itself as an event of the session —
 * `pipe.rs` forwards those to `onSessionEvent`. A caller that wants the effect of
 * a model change or a compaction watches the events, not the answer of the call.
 */

import type {
    AvailableModelsData,
    AvailableThinkingLevelsData,
    BashResult,
    ClearQueueData,
    CommandsData,
    CompactionResult,
    ImageContent,
    LastAssistantTextData,
    Model,
    ModelThinkingLevel,
    PromptData,
    StreamingBehavior,
} from "@/lib/protocol";
import { call } from "./invoke";

/**
 * One image that a person picked, with the name of the file it came from.
 *
 * The name is for the chip that the composer shows. Pi never sees it: the
 * `images` of a prompt carry no name. A picker on Android answers with a
 * `content://` URI, which may have no name of its own; such a picture is called
 * `Image`.
 */
export interface PickedImage {
    /** The name of the file, or `Image` when the picker gave none. */
    name: string;
    /** The picture, as the `images` of a prompt take it. */
    image: ImageContent;
}

/**
 * Asks the person for images to attach to a message.
 *
 * The answer is what a prompt takes as its `images`: base64 with a MIME type,
 * each with the name of the file for the chip. `null` means that the person
 * closed the picker, which is not a failure. A file that cannot be read fails as
 * [`PieError`](@/lib/bridge/error), and the toast then blames the selected file,
 * not pie.
 */
export async function pickImages(): Promise<PickedImage[] | null> {
    return call<PickedImage[] | null>("pick_images");
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
 * `images` are the pictures of the message, as {@link pickImages} answered them;
 * pi processes them itself.
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
