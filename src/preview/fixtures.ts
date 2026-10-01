/**
 * Fixture replay for Storybook and tests — preview infrastructure, not app
 * code and not a protocol implementation.
 *
 * `src-tauri/tests/fixtures/*.jsonl` is real `pi --mode rpc` stdout recorded
 * from the pinned release. Replaying it through the same payload types the app
 * renders keeps component stories on real traffic instead of invented data.
 *
 * This helper only classifies a line by its tag so a story can pick records
 * apart. It does not validate shapes and does not degrade records: parsing,
 * framing and degradation are Rust's (`src-tauri/src/pi_rpc`), and the app
 * receives normalized payloads through `src/lib/bridge.ts`.
 */

import type { AgentMessage, Event, ExtensionError, ExtensionUiRequest, Response } from "@/lib/protocol";

/** One replayed record, classified by tag for preview purposes only. */
export type PreviewRecord =
    | { kind: "response"; response: Response }
    | { kind: "event"; event: Event }
    | { kind: "extension_ui_request"; request: ExtensionUiRequest }
    | { kind: "extension_error"; error: ExtensionError }
    | { kind: "unclassifiable"; raw: unknown };

/** Classifies one JSONL line by tag. */
export function classifyRecord(line: string): PreviewRecord {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return { kind: "unclassifiable", raw: line };
    }
    if (typeof raw !== "object" || raw === null) {
        return { kind: "unclassifiable", raw };
    }
    const type = (raw as { type?: unknown }).type;
    switch (type) {
        case "response":
            return { kind: "response", response: raw as Response };
        case "extension_ui_request":
            return { kind: "extension_ui_request", request: raw as ExtensionUiRequest };
        case "extension_error":
            return { kind: "extension_error", error: raw as ExtensionError };
        default:
            return { kind: "event", event: raw as Event };
    }
}

/** Parses one JSONL fixture into preview records, skipping blank lines. */
export function parseFixture(raw: string): PreviewRecord[] {
    return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => classifyRecord(line));
}

/** Finds the last successful response to `command` and returns its payload. */
export function responseData<T>(records: PreviewRecord[], command: string): T | undefined {
    for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (record.kind === "response" && record.response.command === command && record.response.success) {
            return record.response.data as T;
        }
    }
    return undefined;
}

/** Every response to `command`, in arrival order (successful or not). */
export function responses(records: PreviewRecord[], command: string): Response[] {
    return records.flatMap((record) =>
        record.kind === "response" && record.response.command === command ? [record.response] : [],
    );
}

/** Text parts of a message, concatenated. */
export function messageText(message: AgentMessage): string {
    if (message.role !== "assistant" && message.role !== "user" && message.role !== "system") {
        return "";
    }
    const content = message.content;
    if (typeof content === "string") {
        return content;
    }
    return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Text of the last assistant message in the stream. */
export function lastAssistantText(records: PreviewRecord[]): string | undefined {
    let text: string | undefined;
    for (const record of records) {
        if (record.kind !== "event") {
            continue;
        }
        const event = record.event;
        if (event.type === "message_end" && event.message.role === "assistant") {
            const candidate = messageText(event.message);
            if (candidate !== "") {
                text = candidate;
            }
        }
    }
    return text;
}

/** Text reconstructed from `text_delta` streaming updates, in arrival order. */
export function streamedText(records: PreviewRecord[]): string {
    let text = "";
    for (const record of records) {
        if (record.kind !== "event" || record.event.type !== "message_update") {
            continue;
        }
        const update = record.event.assistantMessageEvent;
        if (update.type === "text_delta") {
            text += update.delta;
        }
    }
    return text;
}
