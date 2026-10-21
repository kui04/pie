import { describe, expect, it } from "vitest";
import { displayText, expandTabs, linesOf, messageText, numberedLines, resultText, stripAnsi } from "../text";

describe("the text of a tool, as the display shows it", () => {
    it("drops the escapes a terminal understands, colours and links alike", () => {
        // A colour sequence, and an OSC hyperlink - the shape a tool emits.
        const coloured = "\u001b[31mred\u001b[0m";
        const link = "\u001b]8;;https://example.com\u0007the link\u001b]8;;\u0007";

        expect(stripAnsi(coloured)).toBe("red");
        expect(stripAnsi(link)).toBe("the link");
    });

    it("shows a tab as three spaces, and drops a carriage return", () => {
        expect(expandTabs("a\tb")).toBe("a   b");
        // Pi drops `\r` too (`normalizeDisplayText`); it does not replay the line.
        expect(displayText("foo\rbar")).toBe("foobar");
    });

    it("keeps no trailing empty line", () => {
        expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
    });

    it("drops the control characters an output may carry", () => {
        // A bell, a null and a backspace: pi removes them (`sanitizeBinaryOutput`),
        // and keeps the three that carry meaning.
        expect(displayText("a\u0007b\u0000c\u0008d")).toBe("abcd");
        expect(displayText("a\tb\nc\rd")).toBe("a   b\ncd");
        expect(displayText("keep \uFFF9this\uFFFB too")).toBe("keep this too");
    });

    it("runs the text blocks of a message together, and starts a new line per result block", () => {
        const parts = [
            { type: "text", text: "one " },
            { type: "image", text: undefined },
            { type: "text", text: "two" },
        ];

        // Pi joins a message a person wrote with nothing between the blocks
        // (`getUserMessageText`), and the blocks of a tool result as line groups.
        expect(messageText(parts)).toBe("one two");
        expect(messageText("as written")).toBe("as written");
        expect(resultText(parts)).toBe("one \ntwo");
    });

    it("splits a diff line into number, mark and text, and leaves a skip line whole", () => {
        // Pi's own shapes (`generateDiffString` of `core/tools/edit-diff.ts`).
        const diff = ["  12 const a = 1;", "- 13 old();", "+ 13 new();", "     ..."];
        const [context, removed, added, skipped] = numberedLines(diff);

        expect(context).toEqual({ mark: " ", number: "12", text: "const a = 1;" });
        expect(removed).toEqual({ mark: "-", number: "13", text: "old();" });
        expect(added).toEqual({ mark: "+", number: "13", text: "new();" });
        expect(skipped).toEqual({ mark: " ", number: null, text: "..." });
    });
});
