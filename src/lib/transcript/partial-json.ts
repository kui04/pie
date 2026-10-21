import type { JsonValue } from "@/lib/rpc-protocol";

/**
 * Reading JSON that is still being written.
 *
 * A tool call's arguments arrive as fragments (`toolcall_delta`), so the text of a
 * call is often not valid JSON yet: a string is open, a brace has not arrived, a
 * provider wrote a raw newline inside a string. Pi reads the same stream with
 * `partial-json` plus a repair pass (`packages/ai/src/utils/json-parse.ts`); this is
 * that behaviour without the dependency: complete JSON is read as it stands, text
 * that only needs its escapes repaired is repaired, and anything shorter is read as
 * far as it goes - the members that arrived, the characters written so far.
 *
 * The answer is always an object, because the arguments of a call are one: a
 * fragment that reads as anything else is no arguments yet.
 */

/** What a fragment stream has produced so far, as the arguments of a call. */
export function parseStreamingJson(text: string | undefined): Record<string, JsonValue> {
    if (text === undefined || text.trim() === "") return {};

    // The common case by far is a fragment that is already whole.
    const whole = asObject(attempt(text));
    if (whole !== null) return whole;

    const repaired = asObject(attempt(repairJson(text)));
    if (repaired !== null) return repaired;

    return asObject(readValue(text, 0)?.value) ?? {};
}

/**
 * Escapes a string the way a provider should have: raw control characters inside a
 * string become their escape, and a backslash in front of a character that is not an
 * escape becomes a literal backslash.
 */
function repairJson(json: string): string {
    let repaired = "";
    let inString = false;

    for (let index = 0; index < json.length; index += 1) {
        const char = json[index];

        if (!inString) {
            repaired += char;
            if (char === '"') inString = true;
            continue;
        }
        if (char === '"') {
            repaired += char;
            inString = false;
            continue;
        }
        if (char === "\\") {
            const next = json[index + 1];
            if (next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(index + 2, index + 6))) {
                repaired += json.slice(index, index + 6);
                index += 5;
                continue;
            }
            if (next !== undefined && ESCAPES.has(next)) {
                repaired += `\\${next}`;
                index += 1;
                continue;
            }
            // A dangling backslash, or one that escapes nothing: it is a literal one.
            repaired += "\\\\";
            continue;
        }
        repaired += char.codePointAt(0)! < 0x20 ? escapeControl(char) : char;
    }

    return repaired;
}

/** The characters a backslash may escape in JSON. */
const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** What an escape stands for, once decoded. */
const DECODED: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
};

function escapeControl(char: string): string {
    const code = char.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
}

/** A read of complete JSON, or `undefined` where it is not JSON at all. */
function attempt(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function asObject(value: unknown): Record<string, JsonValue> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : null;
}

interface Read {
    /** What was read. */
    value: unknown;
    /** Where the reader stopped: the end of the text for a read that ran out of it. */
    at: number;
}

/**
 * Reads one value as far as the text carries it: a container keeps the members that
 * arrived, and a string keeps the characters written so far. `null` where nothing of
 * a value is there yet.
 */
function readValue(text: string, from: number): Read | null {
    const start = skipSpace(text, from);
    if (start >= text.length) return null;

    if (text[start] === "{") return readObject(text, start + 1);
    if (text[start] === "[") return readArray(text, start + 1);
    if (text[start] === '"') return readString(text, start);

    let at = start;
    while (at < text.length && !",]}: \t\n\r".includes(text[at])) at += 1;
    const value = attempt(text.slice(start, at));
    return value === undefined ? null : { value, at };
}

function readObject(text: string, from: number): Read {
    const members: Record<string, JsonValue> = {};
    let at = skipSpace(text, from);

    while (at < text.length && text[at] !== "}") {
        const key = readString(text, at);
        if (key === null) break;
        at = skipSpace(text, key.at);
        if (text[at] !== ":") break;
        const value = readValue(text, at + 1);
        if (value === null) break;
        if (typeof key.value === "string") members[key.value] = value.value as JsonValue;
        at = skipSpace(text, value.at);
        if (text[at] !== ",") break;
        at = skipSpace(text, at + 1);
    }

    return { value: members, at: close(text, at, "}") };
}

function readArray(text: string, from: number): Read {
    const items: unknown[] = [];
    let at = skipSpace(text, from);

    while (at < text.length && text[at] !== "]") {
        const item = readValue(text, at);
        if (item === null) break;
        items.push(item.value);
        at = skipSpace(text, item.at);
        if (text[at] !== ",") break;
        at = skipSpace(text, at + 1);
    }

    return { value: items, at: close(text, at, "]") };
}

/** Where a container's read ends: past the bracket that closed it, at a text that ran out. */
function close(text: string, at: number, bracket: string): number {
    return text[at] === bracket ? at + 1 : at;
}

/** A string: its characters, with the escapes that arrived decoded. */
function readString(text: string, from: number): Read | null {
    if (text[from] !== '"') return null;

    let at = from + 1;
    while (at < text.length) {
        if (text[at] === "\\") {
            at += 2;
            continue;
        }
        if (text[at] === '"') return { value: decode(text.slice(from + 1, at)), at: at + 1 };
        at += 1;
    }

    // A string that never closed holds what has been written, minus an escape that is
    // still being written.
    return { value: decode(unfinished(text.slice(from + 1))), at };
}

/** The body of a string that never closed, without the escape still being written. */
function unfinished(body: string): string {
    let at = 0;
    while (at < body.length) {
        if (body[at] !== "\\") {
            at += 1;
            continue;
        }
        const escape = body.slice(at, at + 6);
        if (/^\\u[0-9a-fA-F]{4}/.test(escape)) {
            at += 6;
            continue;
        }
        // `\u` without its four digits, or a lone backslash: half of an escape.
        if (escape.startsWith("\\u") || at + 1 >= body.length) return body.slice(0, at);
        at += 2;
    }
    return body;
}

/** The characters of a string body, with its escapes decoded. */
function decode(body: string): string {
    let text = "";
    for (let at = 0; at < body.length; at += 1) {
        const char = body[at];
        if (char !== "\\") {
            text += char;
            continue;
        }
        const next = body[at + 1];
        if (next === "u") {
            const code = Number.parseInt(body.slice(at + 2, at + 6), 16);
            text += Number.isNaN(code) ? "" : String.fromCharCode(code);
            at += 5;
            continue;
        }
        text += DECODED[next] ?? next;
        at += 1;
    }
    return text;
}

function skipSpace(text: string, at: number): number {
    while (at < text.length && " \t\n\r".includes(text[at])) at += 1;
    return at;
}
