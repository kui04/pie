import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../partial-json";

/** The texts a fragment stream of one tool call passes through, and what each one reads as. */
describe("the arguments of a call that is still being written", () => {
    it("reads text that is already whole", () => {
        expect(parseStreamingJson('{"path":"/tmp/a.ts","offset":12}')).toEqual({ path: "/tmp/a.ts", offset: 12 });
        expect(parseStreamingJson("  {}  ")).toEqual({});
    });

    it("keeps the members that arrived, and drops the one that has not", () => {
        expect(parseStreamingJson('{"path":"/tmp/a.ts","offset":')).toEqual({ path: "/tmp/a.ts" });
        expect(parseStreamingJson('{"path":"/tmp/a.ts",')).toEqual({ path: "/tmp/a.ts" });
        expect(parseStreamingJson('{"path":')).toEqual({});
        expect(parseStreamingJson("{")).toEqual({});
        expect(parseStreamingJson("")).toEqual({});
        expect(parseStreamingJson(undefined)).toEqual({});
    });

    it("keeps the characters of a string that has not closed", () => {
        expect(parseStreamingJson('{"path":"/tmp/a')).toEqual({ path: "/tmp/a" });
        expect(parseStreamingJson('{"content":"line one\\nline t')).toEqual({ content: "line one\nline t" });
        // A fragment that ends in the middle of an escape holds no half of one.
        expect(parseStreamingJson('{"path":"/tmp/a\\')).toEqual({ path: "/tmp/a" });
        expect(parseStreamingJson('{"path":"a\\u00')).toEqual({ path: "a" });
    });

    it("reads nested members and lists", () => {
        expect(parseStreamingJson('{"edits":[{"path":"a.ts"},{"path":"b.t')).toEqual({
            edits: [{ path: "a.ts" }, { path: "b.t" }],
        });
        expect(parseStreamingJson('{"limit":10,"flags":["x",')).toEqual({ limit: 10, flags: ["x"] });
    });

    it("repairs the escapes a provider should have written", () => {
        expect(parseStreamingJson('{"command":"printf \'a\nb\'"}')).toEqual({ command: "printf 'a\nb'" });
        expect(parseStreamingJson('{"pattern":"C:\\\\path"}')).toEqual({ pattern: "C:\\path" });
    });

    it("answers an empty object for text that is not arguments at all", () => {
        expect(parseStreamingJson("not json")).toEqual({});
        expect(parseStreamingJson("[1,2")).toEqual({});
        expect(parseStreamingJson('"text"')).toEqual({});
    });
});
