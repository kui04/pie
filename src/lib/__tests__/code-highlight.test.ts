import { beforeAll, describe, expect, it } from "vitest";
import { loadHighlighter, loadedHighlighter, tokensOf } from "@/lib/code-highlight";

// The highlighter is one module and one chunk, so a test that wants colours has to let the
// chunk land. Nothing here re-imports it: the whole file drives the real shiki.
beforeAll(async () => {
    await loadHighlighter();
});

describe("the code highlighter", () => {
    it("names a language by the alias a fence wrote", () => {
        // `ts` is an alias of the TypeScript grammar, and a fence is written with either.
        const short = tokensOf(loadedHighlighter(), "const a = 1;", "ts");
        const long = tokensOf(loadedHighlighter(), "const a = 1;", "typescript");

        expect(short).not.toBeNull();
        expect(long).not.toBeNull();
        expect(short?.flat().map((token) => token.text)).toEqual(long?.flat().map((token) => token.text));
    });

    it("carries both palettes on every token", () => {
        // The colour is chosen by the sheet, not by the tokenizer: a token holds the ink of
        // the dark theme and of the light one, and `index.css` picks the one in force.
        const line = tokensOf(loadedHighlighter(), "const a = 1;", "ts")?.[0][0];

        expect(line?.vars["--shiki-dark"]).toMatch(/^#/);
        expect(line?.vars["--shiki-light"]).toMatch(/^#/);
    });

    it("keeps the tokens of a block it has already read", () => {
        const first = tokensOf(loadedHighlighter(), "let kept = true;", "ts");
        const again = tokensOf(loadedHighlighter(), "let kept = true;", "ts");

        expect(again).toBe(first);
    });

    it("has no colours for a language it does not know", () => {
        // An empty fence, `text`, or a language left out of the bundle: the block is drawn as
        // the words it is, which is a block and not a failure.
        expect(tokensOf(loadedHighlighter(), "anything", "text")).toBeNull();
        expect(tokensOf(loadedHighlighter(), "anything", "cobol")).toBeNull();
    });

    it("has no colours before the chunk has landed", () => {
        expect(tokensOf(null, "const a = 1;", "ts")).toBeNull();
    });
});
