import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "@/lib/fuzzy";

const score = (query: string, text: string) => fuzzyMatch(query, text).score;

describe("the fuzzy matcher", () => {
    it("reads the query case-blind", () => {
        expect(fuzzyMatch("GPT", "gpt-5")).toEqual(fuzzyMatch("gpt", "gpt-5"));
    });

    it("wants every character, in order", () => {
        expect(fuzzyMatch("gpt", "gpt-5").matches).toBe(true);
        // Every character is there, but not in the order the query asks for.
        expect(fuzzyMatch("tpg", "gpt-5").matches).toBe(false);
        expect(fuzzyMatch("xy", "gpt-5").matches).toBe(false);
        // A query longer than the text cannot fit inside it.
        expect(fuzzyMatch("gpt-5-codex-extra", "gpt-5").matches).toBe(false);
    });

    it("counts an empty query as no query at all", () => {
        expect(fuzzyMatch("", "gpt-5")).toEqual({ matches: true, score: 0 });
    });

    it("ranks the whole text over a text that merely holds it", () => {
        expect(score("gpt-5", "gpt-5")).toBeLessThan(score("gpt-5", "gpt-5-codex"));
    });

    it("ranks a run of characters over the same characters scattered", () => {
        expect(score("gpt", "gpt-5")).toBeLessThan(score("gpt", "great-potent-thing"));
    });

    it("ranks a word beginning over the middle of a word", () => {
        expect(score("5", "gpt-5")).toBeLessThan(score("5", "gpt5"));
    });

    it("reads a model name whose digits and letters are swapped", () => {
        // `5gpt` finds `gpt-5` too: the reading with the digits at the end is tried
        // second, and it scores five worse than the reading the query was written in.
        expect(fuzzyMatch("5gpt", "gpt-5").matches).toBe(true);
        expect(score("5gpt", "gpt-5")).toBe(score("gpt5", "gpt-5") + 5);
    });
});

describe("the fuzzy filter", () => {
    const items = ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "openai/gpt-5-codex", "deepseek-flash"];

    it("leaves the items alone while nothing is typed", () => {
        expect(fuzzyFilter(items, "   ", (item) => item)).toEqual(items);
    });

    it("asks every token of the query of every item", () => {
        expect(fuzzyFilter(items, "openai gpt", (item) => item)).toEqual(["openai/gpt-5", "openai/gpt-5-codex"]);
        // A token that no item holds empties the list, not half of it.
        expect(fuzzyFilter(items, "openai sonnet", (item) => item)).toEqual([]);
    });

    it("splits the query on slashes as well as on spaces", () => {
        expect(fuzzyFilter(items, "openai/gpt-5", (item) => item)).toEqual(["openai/gpt-5", "openai/gpt-5-codex"]);
    });

    it("puts the better score first, and leaves the items that tie in the order they came", () => {
        // `beta-z` wins because its `z` comes first; `alpha-z` and `gamma-z` score the
        // same, and the sort is stable, so they keep the order they were given in.
        expect(fuzzyFilter(["alpha-z", "beta-z", "gamma-z"], "z", (item) => item)).toEqual([
            "beta-z",
            "alpha-z",
            "gamma-z",
        ]);
    });
});
