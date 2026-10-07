import { describe, expect, it } from "vitest";
import { transcriptRows, type TranscriptRow } from "@/lib/transcript";
import {
    assistant,
    bashExecution,
    chain,
    messageEntry,
    modelChange,
    storeOf,
    text,
    thinking,
    toolCall,
    toolResult,
    usageEntry,
    user,
} from "@/preview/fixtures";

const kinds = (rows: TranscriptRow[]) => rows.map((row) => row.kind);
const ids = (rows: TranscriptRow[]) => rows.map((row) => row.id);

describe("transcriptRows", () => {
    it("renders a message, and leaves out what pi's transcript leaves out", () => {
        const entries = chain(
            modelChange(),
            usageEntry(),
            messageEntry(user("make the parser skip empty lines")),
            messageEntry(assistant([{ type: "text", text: "done" }])),
        );

        const rows = transcriptRows(storeOf(entries), "e4");

        expect(kinds(rows)).toEqual(["user", "assistant"]);
        expect(ids(rows)).toEqual(["e3", "e4"]);
    });

    it("renders no row for a system message, wherever it stands", () => {
        const withSystem = chain(
            messageEntry(user("one")),
            messageEntry({ role: "system", content: "you are a helpful agent", timestamp: 0 }),
            messageEntry(user("two")),
        );

        const rows = transcriptRows(storeOf(withSystem), "e3");

        expect(kinds(rows)).toEqual(["user", "user"]);
    });

    it("keeps the blocks of one assistant message in one row", () => {
        const entries = chain(
            messageEntry(
                assistant([
                    thinking("why not parse by hand"),
                    text("here it is"),
                    toolCall("c1", "read", { path: "/a.ts" }),
                ]),
            ),
        );

        const rows = transcriptRows(storeOf(entries), "e1");

        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe("assistant");
    });

    it("puts a result in the row of the call it answers", () => {
        const entries = chain(
            messageEntry(assistant([toolCall("c1", "read", { path: "/a.ts" })], { stopReason: "toolUse" })),
            messageEntry(toolResult("c1", "read", "the file")),
            messageEntry(user("next")),
        );

        const rows = transcriptRows(storeOf(entries), "e3");

        expect(kinds(rows)).toEqual(["assistant", "user"]);
        expect(rows[0].kind === "assistant" && rows[0].results.get("c1")?.toolName).toBe("read");
    });

    it("drops a result whose call was not rendered", () => {
        // A compaction can keep a result while the call it answers is summarized
        // away. Pi renders nothing of the result then (`renderSessionItems`).
        const entries = chain(
            messageEntry(assistant([toolCall("c1", "read", { path: "/a.ts" })], { stopReason: "toolUse" })),
            messageEntry(toolResult("c1", "read", "the file")),
            messageEntry(toolResult("c9", "read", "a call of another branch")),
        );

        const rows = transcriptRows(storeOf(entries), "e3");

        expect(kinds(rows)).toEqual(["assistant"]);
        expect(rows[0].kind === "assistant" && rows[0].results.size).toBe(1);
    });

    it("renders a shell execution of the reader as its own row", () => {
        const entries = chain(messageEntry(user("one")), messageEntry(bashExecution("ls -la", "total 0")));

        const rows = transcriptRows(storeOf(entries), "e2");

        expect(kinds(rows)).toEqual(["user", "bash"]);
    });

    it("renders a compaction as a notice that carries its summary", () => {
        const entries = chain(
            messageEntry(user("an older ask, which the compaction stands for")),
            {
                type: "compaction",
                timestamp: "2026-01-01T00:00:00.000Z",
                summary: "we made the parser skip empty lines\nand then stopped",
                firstKeptEntryId: "e3",
                tokensBefore: 1000,
            },
            messageEntry(user("the ask that was kept")),
        );

        const rows = transcriptRows(storeOf(entries), "e3");

        expect(kinds(rows)).toEqual(["notice", "user"]);
        expect(ids(rows)).toEqual(["e2", "e3"]);
        const notice = rows[0];
        expect(notice.kind === "notice" && notice.label).toBe("[compaction]");
        expect(notice.kind === "notice" && notice.summary).toBe("we made the parser skip empty lines");
        expect(notice.kind === "notice" && notice.body).toContain("and then stopped");
    });

    it("offers no body for a notice of one line", () => {
        const entries = chain({
            type: "compaction",
            timestamp: "2026-01-01T00:00:00.000Z",
            summary: "short",
            firstKeptEntryId: "e7",
            tokensBefore: 10,
        });

        const rows = transcriptRows(storeOf(entries), "e1");

        expect(rows[0].kind === "notice" && rows[0].body).toBeNull();
    });

    it("renders a branch summary only when it has one", () => {
        const withSummary = chain(messageEntry(user("one")), {
            type: "branch_summary",
            timestamp: "2026-01-01T00:00:00.000Z",
            fromId: "e1",
            summary: "the other branch tried a regex",
        });
        const blank = chain(messageEntry(user("one")), {
            type: "branch_summary",
            timestamp: "2026-01-01T00:00:00.000Z",
            fromId: "e1",
            summary: "",
        });

        expect(kinds(transcriptRows(storeOf(withSummary), "e2"))).toEqual(["user", "notice"]);
        expect(kinds(transcriptRows(storeOf(blank), "e2"))).toEqual(["user"]);
    });

    it("labels a custom message with the type its extension gave it", () => {
        const entries = chain(messageEntry(user("one")), {
            type: "custom_message",
            timestamp: "2026-01-01T00:00:00.000Z",
            customType: "skill",
            content: [{ type: "text", text: "the skill ran" }],
            display: true,
        });

        const rows = transcriptRows(storeOf(entries), "e2");

        expect(rows[1].kind === "notice" && rows[1].label).toBe("[skill]");
        expect(rows[1].kind === "notice" && rows[1].summary).toBe("the skill ran");
    });

    it("renders no row for a custom message the extension keeps hidden", () => {
        const entries = chain({
            type: "custom_message",
            timestamp: "2026-01-01T00:00:00.000Z",
            customType: "skill",
            content: "quiet",
            display: false,
        });

        expect(transcriptRows(storeOf(entries), "e1")).toEqual([]);
    });

    it("follows the leaf through a real fork", () => {
        // Two branches out of e2: e3-e4 is one, and the leaf sits on the other.
        const entries = chain(
            messageEntry(user("one")),
            messageEntry(assistant([{ type: "text", text: "first answer" }])),
            messageEntry(user("the branch that was left")),
            messageEntry(assistant([{ type: "text", text: "answer of the left branch" }])),
            messageEntry(user("the branch the leaf is on")),
        );
        entries[4] = { ...entries[4], parentId: "e2" };

        const rows = transcriptRows(storeOf(entries), "e5");

        // The path runs e1, e2, e5: the branch e3-e4 is the session's, not the leaf's.
        expect(ids(rows)).toEqual(["e1", "e2", "e5"]);
    });
});
