/**
 * What pi's display does to text before a person reads it, in the order pi does it
 * (`core/tools/render-utils.ts`).
 */

/** Pi's escape pattern (`utils/ansi.ts`, itself derived from ansi-regex): OSC, then CSI and C1. */
/* eslint-disable no-control-regex -- escapes are control characters; that is the point */
const ANSI =
    /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * What pi drops of an output (`sanitizeBinaryOutput` of `utils/shell.ts`), keeping
 * the tab, the newline and the carriage return, which pi treats elsewhere.
 */
const BINARY = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
    return text.replace(ANSI, "");
}

/** The control characters of an output that are not text: a bell, a null, a backspace. */
function stripBinary(text: string): string {
    return text.replace(BINARY, "");
}

/** One tab, as pi shows it: three spaces. */
export function expandTabs(text: string): string {
    return text.replace(/\t/g, "   ");
}

/** The text of a tool result, as the display shows it: its text blocks, one per line group. */
export function resultText(content: Array<{ type: string; text?: string | null }>): string {
    return content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}

/** The text of a message a person wrote, the way pi reads it: its text blocks run
 * together with nothing between them, unlike a tool result's line groups. */
export function messageText(content: string | Array<{ type: string; text?: string | null }>): string {
    if (typeof content === "string") return content;
    return content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

/** Text as the display shows it: pi's pipeline over `getTextOutput`, then tabs. */
export function displayText(text: string): string {
    return expandTabs(stripBinary(stripAnsi(text)).replace(/\r/g, ""));
}

/** The lines of a text, without a trailing empty line. */
export function linesOf(text: string): string[] {
    const lines = text.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/** One word for an identifier: `skill` reads `Skill`, `tool_search` reads `Tool Search`. */
export function humanize(value: string): string {
    const words = value
        .toLowerCase()
        .split(/[_-]+/)
        .filter((word) => word !== "");
    if (words.length === 0) return value;
    return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** One line of a numbered body: the mark, the number, and the text. */
export interface NumberedLine {
    /** `+`, `-`, or a space for a line that only stands around a change. */
    mark: string;
    /** The line number, without the padding pi aligns it with. */
    number: string | null;
    /** Everything after the number. */
    text: string;
}

/**
 * Pi's display diff, line by line (`generateDiffString` of `core/tools/edit-diff.ts`):
 * `±<padded line number> <text>`, a space for a line kept around a change, and a
 * line of `...` where it skipped the lines in between.
 */
export function numberedLines(lines: string[]): NumberedLine[] {
    return lines.map((line) => {
        const mark = line.slice(0, 1) === "" ? " " : line[0];
        const rest = line.slice(1);
        const numbered = /^(\s*\d+)(?: (.*))?$/.exec(rest);
        if (numbered === null) return { mark, number: null, text: rest.trimStart() };
        return { mark, number: numbered[1].trim(), text: numbered[2] ?? "" };
    });
}

/** A file as a diff without marks: every line numbered from `first`. */
export function numberedFile(lines: string[], first: number): NumberedLine[] {
    return lines.map((text, index) => ({ mark: " ", number: String(first + index), text }));
}
