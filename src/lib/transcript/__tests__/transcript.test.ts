import { describe, expect, it } from "vitest";
import { transcriptRows, type TranscriptRow } from "../rows";
import {
    assistant,
    bashExecution,
    chain,
    contextEditEntry,
    customEntry,
    labelEntry,
    messageEntry,
    modelChange,
    sessionInfo,
    storeOf,
    text,
    thinking,
    thinkingLevelChange,
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

    it("renders a compaction as its own row, header bare and body whole", () => {
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

        expect(kinds(rows)).toEqual(["compaction", "user"]);
        expect(ids(rows)).toEqual(["e2", "e3"]);
        const row = rows[0];
        expect(row.kind === "compaction" && row.tokensBefore).toBe(1000);
        expect(row.kind === "compaction" && row.body).toBe("we made the parser skip empty lines\nand then stopped");
    });

    it("keeps the whole summary behind a compaction, even one line", () => {
        const entries = chain({
            type: "compaction",
            timestamp: "2026-01-01T00:00:00.000Z",
            summary: "short",
            firstKeptEntryId: "e7",
            tokensBefore: 10,
        });

        const rows = transcriptRows(storeOf(entries), "e1");

        expect(rows[0].kind === "compaction" && rows[0].body).toBe("short");
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

        const rows = transcriptRows(storeOf(withSummary), "e2");
        expect(kinds(rows)).toEqual(["user", "branch_summary"]);
        expect(rows[1].kind === "branch_summary" && rows[1].body).toBe("the other branch tried a regex");
        expect(kinds(transcriptRows(storeOf(blank), "e2"))).toEqual(["user"]);
    });

    it("renders a skill custom message as a skill row", () => {
        const entries = chain(messageEntry(user("one")), {
            type: "custom_message",
            timestamp: "2026-01-01T00:00:00.000Z",
            customType: "skill",
            content: [{ type: "text", text: "the skill ran" }],
            display: true,
        });

        const rows = transcriptRows(storeOf(entries), "e2");

        expect(kinds(rows)).toEqual(["user", "skill"]);
        expect(rows[1].kind === "skill" && rows[1].summary).toBe("the skill ran");
        expect(rows[1].kind === "skill" && rows[1].body).toBeNull();
    });

    it("labels any other custom message with the word its extension gave it", () => {
        const entries = chain(messageEntry(user("one")), {
            type: "custom_message",
            timestamp: "2026-01-01T00:00:00.000Z",
            customType: "review",
            content: [
                { type: "text", text: "two files miss coverage" },
                { type: "text", text: "add the missing tests" },
            ],
            display: true,
        });

        const rows = transcriptRows(storeOf(entries), "e2");

        expect(kinds(rows)).toEqual(["user", "custom_message"]);
        const row = rows[1];
        expect(row.kind === "custom_message" && row.customType).toBe("review");
        expect(row.kind === "custom_message" && row.label).toBe("Review");
        // A longer message opens instead: its header stays bare.
        expect(row.kind === "custom_message" && row.summary).toBe("");
        expect(row.kind === "custom_message" && row.body).toContain("add the missing tests");
    });

    it("draws no row for the entries the transcript never shows", () => {
        // Bookkeeping, extension state, edits, bookmarks and metadata: each
        // has its own reader elsewhere, and none of them is a row. A case
        // that starts rendering one fails here first, by design.
        const entries = chain(
            messageEntry(user("one")),
            thinkingLevelChange(),
            modelChange(),
            usageEntry(),
            customEntry(),
            contextEditEntry("e1"),
            labelEntry("e1"),
            sessionInfo("work"),
        );

        const rows = transcriptRows(storeOf(entries), "e8");

        expect(kinds(rows)).toEqual(["user"]);
        expect(ids(rows)).toEqual(["e1"]);
    });

    it("reads the legacy summary roles like their entries", () => {
        // Sessions pi wrote before the summaries became entries carry them
        // as message roles; they draw the same rows.
        const entries = chain(
            messageEntry({
                role: "branchSummary",
                summary: "the abandoned branch",
                fromId: null,
                timestamp: 0,
            }),
            messageEntry({
                role: "compactionSummary",
                summary: "what was compacted",
                tokensBefore: 100,
                timestamp: 0,
            }),
            messageEntry({
                role: "custom",
                customType: "skill",
                content: "the skill ran",
                display: true,
                timestamp: 0,
            }),
        );

        const rows = transcriptRows(storeOf(entries), "e3");

        expect(kinds(rows)).toEqual(["branch_summary", "compaction", "skill"]);
        expect(rows[0].kind === "branch_summary" && rows[0].body).toBe("the abandoned branch");
        expect(rows[1].kind === "compaction" && rows[1].body).toBe("what was compacted");
        expect(rows[2].kind === "skill" && rows[2].summary).toBe("the skill ran");
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
