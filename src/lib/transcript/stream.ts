/**
 * The messages a run is still writing.
 *
 * Pi streams a run as deltas and writes the transcript file to the end of it
 * (`JsonMessageUpdateEvent`, `packages/coding-agent/src/modes/json-event.ts`): the
 * cumulative message is stripped from the wire, so a screen that shows the answer as
 * it grows has to build it from `message_start`, the deltas and `message_end` - which
 * is what these functions do.
 *
 * Two facts of the wire shape this:
 *
 * - A tool result arrives twice. `tool_execution_end` carries the result itself, and
 *   the tool result message that follows it is what pi persists; the first one is
 *   what a card shows while the run goes on, and the read at the end of the run
 *   replaces both with the entries.
 * - A `tool_execution_update` is the whole output so far, not a piece of it
 *   (`emitOutputUpdate` of `packages/coding-agent/src/core/tools/bash.ts`), so what a
 *   call streamed before gives way to what it streamed last.
 *
 * Nothing here draws: the rows it answers with are the rows the fold of the snapshot
 * builds (`lib/transcript/rows.ts`), so the screen renders one shape either way.
 */

import type {
    AgentMessage,
    AssistantContentPart,
    AssistantMessageEvent,
    JsonValue,
    ToolCall,
    ToolResultMessage,
} from "@/lib/rpc-protocol";
import { parseStreamingJson } from "./partial-json";
import type { TranscriptRow } from "./rows";

/** An assistant message as the wire carries it: the message, and the role that tags it. */
type WireAssistant = Extract<AgentMessage, { role: "assistant" }>;

/** What one tool call of the run is doing. */
export interface LiveCall {
    /** The call runs right now, and `result` is what it streamed so far. */
    running: boolean;
    /** What the call answered: its result, or the result it is becoming. */
    result: ToolResultMessage | null;
}

/** A message the events of a run are still writing. */
export interface LiveMessage {
    /** The row's own name: a message on the wire has no id, and a row needs one. */
    id: string;
    /** The message as far as the events built it. */
    message: AgentMessage;
    /** The JSON of every call the model is still writing, by call id. */
    args: Map<string, string>;
    /** How much of each call's JSON was last read into its arguments, by call id. */
    parsed: Map<string, number>;
    /** When each call's arguments were last read, by call id. */
    parsedAt: Map<string, number>;
    /** Every call of this message, by call id. */
    calls: Map<string, LiveCall>;
    /** Pi runs this turn again: the failure of this message is not the last word. */
    retrying: boolean;
}

/** A call whose arguments stay this short is read on every delta. */
const ARG_PARSE_ALWAYS = 2_048;

/** A longer call is read at this interval: a file being written is not redrawn per character. */
const ARG_PARSE_MS = 120;

/**
 * The messages of the run, in the order they began. Only the bytes: the phase of the run
 * is the chart's, because a read that lands mid-run takes these rows over and the phase
 * must not go with them (`.agents/rules/state.md`).
 */
export interface LiveRun {
    messages: LiveMessage[];
}

/** The phase of a run, as the chart of the session holds it and the line under it says. */
export type RunPhase = "idle" | "waiting" | "working";

/** The messages that wait for a run, as `queue_update` reports them. */
export interface QueuedMessages {
    /** Messages that interrupt the run at its next step. */
    steering: readonly string[];
    /** Messages that wait for the run to settle. */
    followUp: readonly string[];
}

/** A run that has written nothing yet. */
export const noRun: LiveRun = { messages: [] };

/** A message that a run began writing. A role the transcript does not draw is no row. */
export function beginMessage(run: LiveRun, id: string, message: AgentMessage): LiveRun {
    if (message.role !== "user" && message.role !== "assistant") return run;
    const live: LiveMessage = {
        id,
        message,
        args: new Map(),
        parsed: new Map(),
        parsedAt: new Map(),
        calls: new Map(),
        retrying: false,
    };
    return { messages: [...run.messages, live] };
}

/**
 * A message that finished: the authoritative one replaces what the deltas built, with
 * the row, the call ids and the streamed results it already had.
 */
export function endMessage(run: LiveRun, message: AgentMessage): LiveRun {
    return mapLast(run, message.role, (live) => withMessage(live, message));
}

/**
 * One delta of the message that streams. A delta with no message of its own to land
 * in is dropped: the listeners opened after the run began, and only the read that
 * follows the run covers what it missed.
 */
export function applyDelta(run: LiveRun, event: AssistantMessageEvent): LiveRun {
    return mapLast(run, "assistant", (live) => {
        const next = delta(live, event);
        return {
            ...live,
            message: next.message ?? live.message,
            args: next.args ?? live.args,
            parsed: next.parsed ?? live.parsed,
            parsedAt: next.parsedAt ?? live.parsedAt,
        };
    });
}

/** The message and the buffers of one delta, or nothing where it belongs to no part. */
function delta(
    live: LiveMessage,
    event: AssistantMessageEvent,
): {
    message?: WireAssistant;
    args?: Map<string, string>;
    parsed?: Map<string, number>;
    parsedAt?: Map<string, number>;
} {
    const message = live.message;
    if (message.role !== "assistant") return {};

    switch (event.type) {
        case "text_start":
            return { message: withPart(message, event.contentIndex, textPart(message, event.contentIndex)) };
        case "text_delta": {
            const part = textPart(message, event.contentIndex);
            return { message: withPart(message, event.contentIndex, { ...part, text: part.text + event.delta }) };
        }
        case "text_end":
            return { message: withPart(message, event.contentIndex, { type: "text", text: event.content }) };
        case "thinking_start":
            return { message: withPart(message, event.contentIndex, thinkingPart(message, event.contentIndex)) };
        case "thinking_delta": {
            const part = thinkingPart(message, event.contentIndex);
            return {
                message: withPart(message, event.contentIndex, { ...part, thinking: part.thinking + event.delta }),
            };
        }
        case "thinking_end":
            return { message: withPart(message, event.contentIndex, { type: "thinking", thinking: event.content }) };
        case "toolcall_start": {
            const call: ToolCall = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
            const args = new Map(live.args).set(event.id, "");
            const parsed = new Map(live.parsed);
            parsed.delete(event.id);
            const parsedAt = new Map(live.parsedAt);
            parsedAt.delete(event.id);
            return { message: withPart(message, event.contentIndex, call), args, parsed, parsedAt };
        }
        case "toolcall_delta": {
            const call = callAt(message, event.contentIndex);
            if (call === null) return {};
            // The arguments are read as the text arrives, so a call that writes a file
            // shows the file growing, the way pi's own card does. A long one is read at
            // intervals: parsing the whole argument block on every delta is quadratic.
            const json = (live.args.get(call.id) ?? "") + event.delta;
            const args = new Map(live.args).set(call.id, json);
            const read = live.parsed.get(call.id) ?? 0;
            const now = Date.now();
            const shouldParse =
                read === 0 ||
                json.length <= ARG_PARSE_ALWAYS ||
                now - (live.parsedAt.get(call.id) ?? 0) >= ARG_PARSE_MS;
            if (!shouldParse) return { args };
            const parsed = new Map(live.parsed).set(call.id, json.length);
            const parsedAt = new Map(live.parsedAt).set(call.id, now);
            return {
                message: withPart(message, event.contentIndex, {
                    ...call,
                    arguments: parseStreamingJson(json),
                }),
                args,
                parsed,
                parsedAt,
            };
        }
        case "toolcall_end": {
            const args = new Map(live.args);
            args.delete(event.toolCall.id);
            const parsed = new Map(live.parsed);
            parsed.delete(event.toolCall.id);
            const parsedAt = new Map(live.parsedAt);
            parsedAt.delete(event.toolCall.id);
            return { message: withPart(message, event.contentIndex, event.toolCall), args, parsed, parsedAt };
        }
        default:
            // `start`, `done` and `error` carry no part of their own: the whole message
            // arrives with `message_end`.
            return {};
    }
}

/** A tool call that started: its arguments are known now, and it runs. */
export function startCall(run: LiveRun, call: { toolCallId: string; args: JsonValue }): LiveRun {
    return mapOwner(run, call.toolCallId, (live) => ({
        ...live,
        message: withCallArgs(live.message, call.toolCallId, call.args),
        calls: withCall(live.calls, call.toolCallId, { running: true }),
    }));
}

/** What a call streamed, as the result it is becoming. */
export function updateCall(
    run: LiveRun,
    call: { toolCallId: string; toolName: string; partialResult: JsonValue },
): LiveRun {
    return mapOwner(run, call.toolCallId, (live) => ({
        ...live,
        calls: withCall(live.calls, call.toolCallId, {
            running: true,
            result: asResultMessage(call, call.partialResult, false),
        }),
    }));
}

/** What a call answered. */
export function endCall(
    run: LiveRun,
    call: { toolCallId: string; toolName: string; result: JsonValue; isError: boolean },
): LiveRun {
    return mapOwner(run, call.toolCallId, (live) => ({
        ...live,
        calls: withCall(live.calls, call.toolCallId, {
            running: false,
            result: asResultMessage(call, call.result, call.isError),
        }),
    }));
}

/** Pi runs this turn again: the failure of the message is not the end of the run. */
export function markRetrying(run: LiveRun): LiveRun {
    return mapLast(run, "assistant", (live) => ({ ...live, retrying: true }));
}

/** The rows of the run, in the shape the fold of the snapshot answers with. */
export function liveRows(run: LiveRun): TranscriptRow[] {
    return run.messages.flatMap((live): TranscriptRow[] => {
        if (live.message.role === "user") {
            return [{ kind: "user", id: live.id, message: live.message }];
        }
        if (live.message.role !== "assistant") return [];

        const results = new Map<string, ToolResultMessage>();
        for (const [id, call] of live.calls) {
            if (call.result !== null) results.set(id, call.result);
        }
        return [
            {
                kind: "assistant",
                id: live.id,
                message: live.message,
                results,
                live: { calls: live.calls, retrying: live.retrying },
            },
        ];
    });
}

/** The live message that holds another message, with the rest of its state kept. */
function withMessage(live: LiveMessage, message: AgentMessage): LiveMessage {
    const next: LiveMessage = { ...live };
    next.message = message;
    return next;
}

/**
 * The line under the run, when the run goes on: it is not the model's, it is the app
 * waiting on a machine that may be far away, so no message writes it.
 */
export function activityRows(phase: RunPhase): TranscriptRow[] {
    if (phase === "idle") return [];
    return [{ kind: "activity", id: "activity", state: phase }];
}

/** The last message of one role, with `update` applied to it. */
function mapLast(run: LiveRun, role: AgentMessage["role"], update: (live: LiveMessage) => LiveMessage): LiveRun {
    for (let index = run.messages.length - 1; index >= 0; index -= 1) {
        if (run.messages[index].message.role !== role) continue;
        const messages = [...run.messages];
        messages[index] = update(messages[index]);
        return { messages };
    }
    return run;
}

/** The message that owns one call, with `update` applied to it. */
function mapOwner(run: LiveRun, toolCallId: string, update: (live: LiveMessage) => LiveMessage): LiveRun {
    for (let index = run.messages.length - 1; index >= 0; index -= 1) {
        const live = run.messages[index];
        if (!live.calls.has(toolCallId) && !hasCall(live.message, toolCallId)) continue;
        const messages = [...run.messages];
        messages[index] = update(live);
        return { messages };
    }
    return run;
}

/** The calls of a message with one of them added or replaced, the rest untouched. */
function withCall(calls: Map<string, LiveCall>, toolCallId: string, change: Partial<LiveCall>): Map<string, LiveCall> {
    const next = new Map(calls);
    const call = next.get(toolCallId) ?? { running: false, result: null };
    next.set(toolCallId, { ...call, ...change });
    return next;
}

/** Whether a message carries this call. */
function hasCall(message: AgentMessage, toolCallId: string): boolean {
    return (
        message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)
    );
}

/** The message with the arguments of one call filled in. */
function withCallArgs(message: AgentMessage, toolCallId: string, args: JsonValue): AgentMessage {
    if (message.role !== "assistant") return message;
    const at = message.content.findIndex((part) => part.type === "toolCall" && part.id === toolCallId);
    if (at < 0) return message;
    const call = message.content[at] as ToolCall;
    return withPart(message, at, { ...call, arguments: asArgs(args) });
}

/** The arguments of a call as the object they are. */
function asArgs(args: JsonValue): Record<string, JsonValue> {
    return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, JsonValue>) : {};
}

/** A wire result (`AgentToolResult`) as the message a card reads. */
function asResultMessage(
    call: { toolCallId: string; toolName: string },
    result: JsonValue,
    isError: boolean,
): ToolResultMessage {
    const bag = asRecord(result);
    return {
        role: "toolResult",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content: asContent(bag?.content),
        details: bag?.details ?? null,
        isError,
        timestamp: Date.now(),
    };
}

/** The content parts of a wire result: the ones this build knows, in order. */
function asContent(content: JsonValue | undefined): ToolResultMessage["content"] {
    if (!Array.isArray(content)) return [];
    const parts: ToolResultMessage["content"] = [];
    for (const part of content) {
        const bag = asRecord(part);
        if (bag?.type === "text" && typeof bag.text === "string") {
            parts.push({ type: "text", text: bag.text });
        } else if (bag?.type === "image" && typeof bag.data === "string" && typeof bag.mimeType === "string") {
            parts.push({ type: "image", data: bag.data, mimeType: bag.mimeType });
        }
    }
    return parts;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : null;
}

/**
 * The message with the part at `index` replaced. A part the text has not reached yet
 * is written as an empty text one, so that the parts stay a list without holes.
 */
function withPart(message: WireAssistant, index: number, part: AssistantContentPart): WireAssistant {
    const content = [...message.content];
    while (content.length < index) content.push({ type: "text", text: "" });
    content[index] = part;
    return { ...message, content };
}

/** The text part at an index, or an empty one where the model has not written it yet. */
function textPart(message: WireAssistant, index: number): { type: "text"; text: string } {
    const part = message.content[index];
    return part?.type === "text" ? { type: "text", text: part.text } : { type: "text", text: "" };
}

/** The reasoning part at an index, or an empty one. */
function thinkingPart(message: WireAssistant, index: number): { type: "thinking"; thinking: string } {
    const part = message.content[index];
    return part?.type === "thinking"
        ? { type: "thinking", thinking: part.thinking }
        : { type: "thinking", thinking: "" };
}

/** The call at an index, when its `toolcall_start` arrived before the delta. */
function callAt(message: WireAssistant, index: number): ToolCall | null {
    const part = message.content[index];
    return part?.type === "toolCall" ? part : null;
}
