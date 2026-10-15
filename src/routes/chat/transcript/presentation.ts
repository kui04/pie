/**
 * How a tool call and its result read on the screen: a title, what the call aimed
 * at, and a body whose form follows the tool (pi: `core/tools/renderers/*.ts`).
 * Everything comes from the call's arguments and the result - the diff of an edit
 * is `details.diff`, which pi fills in for a display that never reads the file.
 */

import type { AssistantMessage, BashExecutionMessage, JsonValue, ToolResultMessage } from "@/lib/rpc-protocol";
import { displayText, linesOf, numberedFile, numberedLines, resultText, type NumberedLine } from "@/lib/text";

export type ToolBody =
    /** Nothing to show: no result yet, or a result with nothing in it. */
    | { kind: "none" }
    /** The lines of a diff, with the line numbers pi put in them. */
    | { kind: "diff"; lines: NumberedLine[] }
    /** The lines of a file, numbered from where the read started. */
    | { kind: "file"; lines: NumberedLine[] }
    /** The lines of an output to read. */
    | { kind: "log"; lines: string[] };

export interface ToolNote {
    text: string;
    tone: "muted" | "warning" | "error";
}

/**
 * Where a call stands. A call without a result inside a message the model is still
 * writing is running, and inside a settled message it is waiting: a transcript
 * cannot tell a call pi still works on from one whose answer is never coming.
 */
export type ToolStatus = "ok" | "failed" | "waiting" | "running";

export interface ToolPresentation {
    /** What the header leads with. */
    title: string;
    /** What the call aimed at: a path, a pattern, a command. */
    detail: string | null;
    /** A tool the model called, or a command the reader ran themselves. */
    tone: "model" | "user-run";
    /** Where the call stands, as far as the transcript can tell. */
    status: ToolStatus;
    body: ToolBody;
    /** What the card says under its body: a truncation, an exit code. */
    notes: ToolNote[];
    /**
     * How long pi took over the call, when its result carries the number. pi measures this for
     * the calls of a run it is driving, and persists it on the result; an older or a streamed
     * result carries none, and then the row keeps its own clock instead.
     */
    durationMs: number | null;
}

/** The rest of the header the generic form shows: `key=value`, cut like pi cuts it. */
const ARGS_CHARS = 100;

export function presentCall(
    name: string,
    args: Record<string, JsonValue>,
    result: ToolResultMessage | null,
    stillWriting = false,
    /**
     * The call runs right now, and `result` is what it streamed so far. It outranks the
     * result, which is not an answer yet: a call of a message the model already finished
     * writing runs while it streams.
     */
    running = false,
): ToolPresentation {
    const output = result ? displayText(resultText(result.content)) : "";
    const lines = linesOf(output);
    const failed = result?.isError === true;
    // A failed result is its error text, whichever tool wrote it.
    const body: ToolBody = failed
        ? genericBody(lines)
        : name === "edit"
          ? editBody(result, lines)
          : name === "read"
            ? fileBody(lines, number(args, "offset") ?? 1)
            : name === "write"
              ? writeBody(args, lines)
              : genericBody(lines);

    return {
        title: name,
        detail: callDetail(name, args),
        tone: "model",
        status: running
            ? "running"
            : result !== null
              ? result.isError
                  ? "failed"
                  : "ok"
              : stillWriting
                ? "running"
                : "waiting",
        body,
        notes: toolNotes(result),
        durationMs: typeof result?.durationMs === "number" ? result.durationMs : null,
    };
}

/**
 * A command the reader ran themselves: the card leads with the shell prompt, and its
 * border carries the colour of their own run (`--color-user-run`).
 */
export function presentExecution(message: BashExecutionMessage): ToolPresentation {
    const notes: ToolNote[] = [];
    if (message.truncated) notes.push({ text: "Output was truncated.", tone: "warning" });
    if (message.cancelled) {
        notes.push({ text: "(cancelled)", tone: "warning" });
    } else if (message.exitCode !== undefined && message.exitCode !== null && message.exitCode !== 0) {
        notes.push({ text: `(exit ${message.exitCode})`, tone: "error" });
    }
    return {
        title: "$",
        detail: message.command,
        tone: "user-run",
        // Its border already colours a reader's own run, so the state says only
        // whether the command finished; the `(cancelled)` and `(exit N)` notes say the rest.
        status:
            message.cancelled || (message.exitCode !== undefined && message.exitCode !== null && message.exitCode !== 0)
                ? "failed"
                : "ok",
        body: { kind: "log", lines: linesOf(displayText(message.output)) },
        notes,
        durationMs: null,
    };
}

/**
 * A shell command that runs right now, as far as pi streamed it: the same card as a
 * recorded run ([`presentExecution`]), with the state that runs its clock. Pi has
 * not ended the command, so it has no exit code yet.
 */
export function presentRunningExecution(run: { command: string; output: string }): ToolPresentation {
    return {
        title: "$",
        detail: run.command,
        tone: "user-run",
        status: "running",
        body: { kind: "log", lines: linesOf(displayText(run.output)) },
        notes: [],
        durationMs: null,
    };
}

/** The body of a tool this build does not know: what it answered, or nothing. */
function genericBody(lines: string[]): ToolBody {
    return lines.length === 0 ? { kind: "none" } : { kind: "log", lines };
}

/**
 * The body of an edit: pi's display diff from the result, or the text it answered
 * with when there is none (an older pi, or a tool an extension replaced).
 */
function editBody(result: ToolResultMessage | null, lines: string[]): ToolBody {
    const diff = detailsString(result?.details, "diff");
    if (diff !== null) return { kind: "diff", lines: numberedLines(linesOf(displayText(diff))) };
    if (lines.length === 0) return { kind: "none" };
    return { kind: "log", lines };
}

/** The body of a read: what came back, numbered from where the read started. */
function fileBody(lines: string[], first: number): ToolBody {
    if (lines.length === 0) return { kind: "none" };
    return { kind: "file", lines: numberedFile(lines, first) };
}

/**
 * The body of a write: what the call writes, which is in its arguments. Pi draws
 * the same content while the call is still in flight, and nothing from a result
 * that succeeded.
 */
function writeBody(args: Record<string, JsonValue>, lines: string[]): ToolBody {
    const content = argString(args, "content");
    if (content !== null) return { kind: "file", lines: numberedFile(linesOf(displayText(content)), 1) };
    if (lines.length === 0) return { kind: "none" };
    return { kind: "log", lines };
}

/** The title's companion: what the call aimed at, as pi's per-tool renderers write it. */
function callDetail(name: string, args: Record<string, JsonValue>): string | null {
    switch (name) {
        case "edit":
            return argString(args, "path", "file_path");
        case "read":
            return argString(args, "path", "file_path");
        case "write":
            return argString(args, "path", "file_path");
        case "ls": {
            const path = argString(args, "path") ?? ".";
            const limit = number(args, "limit");
            return limit === null ? path : `${path} (limit ${limit})`;
        }
        case "grep": {
            const pattern = argString(args, "pattern");
            if (pattern === null) return argsSummary(args);
            const path = argString(args, "path") ?? ".";
            const glob = argString(args, "glob");
            const limit = number(args, "limit");
            let detail = `/${pattern}/ in ${path}`;
            if (glob !== null) detail += ` (${glob})`;
            if (limit !== null) detail += ` limit ${limit}`;
            return detail;
        }
        case "find": {
            const pattern = argString(args, "pattern");
            if (pattern === null) return argsSummary(args);
            const path = argString(args, "path") ?? ".";
            const limit = number(args, "limit");
            return limit === null ? `${pattern} in ${path}` : `${pattern} in ${path} (limit ${limit})`;
        }
        case "bash": {
            const command = argString(args, "command") ?? "";
            const timeout = number(args, "timeout");
            return timeout === null ? command : `${command} (timeout ${timeout}s)`;
        }
        default:
            return argsSummary(args);
    }
}

/**
 * The generic header for a tool this build does not know: `key=value` pairs, cut
 * where pi cuts them (`formatToolCallWithArgs` of `core/tools/render-utils.ts`).
 */
function argsSummary(args: Record<string, JsonValue>): string | null {
    const entries = Object.entries(args);
    if (entries.length === 0) return null;
    const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
    return pairs.length > ARGS_CHARS ? `${pairs.slice(0, ARGS_CHARS - 3)}...` : pairs;
}

/**
 * What pi warns about under a result: a truncation, and where the whole of a
 * truncated output went (`core/tools/renderers/bash.ts`, `read.ts`).
 */
function toolNotes(result: ToolResultMessage | null): ToolNote[] {
    if (!result) return [];
    const notes: ToolNote[] = [];
    const truncation = detailsObject(result.details, "truncation");
    if (truncation?.truncated === true) {
        const shown = numberValue(truncation.outputLines);
        const total = numberValue(truncation.totalLines);
        notes.push({
            text: shown !== null && total !== null ? `Truncated: ${shown} of ${total} lines` : "Truncated",
            tone: "warning",
        });
    }
    const fullOutputPath = detailsString(result.details, "fullOutputPath");
    if (fullOutputPath !== null) notes.push({ text: `Full output: ${fullOutputPath}`, tone: "muted" });
    return notes;
}

/** A string argument, by any of the names the tool may use for it. */
function argString(args: Record<string, JsonValue>, ...keys: string[]): string | null {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === "string") return value;
    }
    return null;
}

function number(args: Record<string, JsonValue>, key: string): number | null {
    return numberValue(args[key]);
}

function numberValue(value: JsonValue | undefined): number | null {
    return typeof value === "number" ? value : null;
}

/** A string field of a `details` bag, when the tool put one there. */
function detailsString(details: JsonValue | null | undefined, key: string): string | null {
    const value = detailsField(details, key);
    return typeof value === "string" ? value : null;
}

function detailsObject(details: JsonValue | null | undefined, key: string): Record<string, JsonValue> | null {
    return asJsonObject(detailsField(details, key));
}

/**
 * `details` crosses the wire as free JSON, so every reader of it narrows. A bag
 * that is absent, null, or not an object has no fields.
 */
function detailsField(details: JsonValue | null | undefined, key: string): JsonValue | undefined {
    const bag = asJsonObject(details);
    return bag === null ? undefined : bag[key];
}

/**
 * A JSON value as an object, or `null` for anything else.
 *
 * The cast is what the check already proved: pi types a JSON array as
 * `readonly JsonValue[]`, which is not assignable to `any[]`, so `Array.isArray`
 * leaves the array case in the union.
 */
function asJsonObject(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : null;
}
/**
 * The one line a turn that did not end cleanly says, following pi's rule
 * (`modes/interactive/components/assistant-message.ts`): a truncated answer always
 * gets the line, an abort or an error does not when the message called tools - the
 * call that took the failure shows it.
 */
export function stopNote(message: AssistantMessage): string | null {
    if (message.stopReason === "length") return "Response was truncated before completion.";
    if (message.content.some((part) => part.type === "toolCall")) return null;
    const reason = failureText(message);
    if (reason === null) return null;
    return message.stopReason === "error" ? `Error: ${reason}` : reason;
}

export function failureText(message: AssistantMessage): string | null {
    if (message.stopReason === "aborted") {
        const said = message.errorMessage;
        return said !== undefined && said !== null && said !== "" && said !== "Request was aborted"
            ? said
            : "Operation aborted";
    }
    if (message.stopReason === "error") return message.errorMessage || "Unknown error";
    return null;
}

/** A call that never answered, read as the message's own failure. */
export function failedCall(message: AssistantMessage, toolCallId: string, toolName: string): ToolResultMessage | null {
    const text = failureText(message);
    if (text === null) return null;
    return {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: true,
        timestamp: message.timestamp,
    };
}
