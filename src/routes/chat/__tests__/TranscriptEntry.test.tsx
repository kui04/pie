import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@/lib/rpc-protocol";
import { transcriptRows } from "@/lib/transcript";
import {
    assistant,
    bashExecution,
    chain,
    messageEntry,
    storeOf,
    text,
    toolCall,
    toolResult,
    user,
} from "@/preview/fixtures";
import { TranscriptEntry } from "@/routes/chat/transcript/TranscriptEntry";

/** The rows of a session, as the screen draws them. */
function transcript(entries: SessionEntry[]) {
    const store = storeOf(entries);
    const leafId: string | null = store.order.length > 0 ? store.order[store.order.length - 1] : null;
    return transcriptRows(store, leafId).map((row) => <TranscriptEntry key={row.id} row={row} />);
}

describe("TranscriptEntry", () => {
    it("draws the entries of a session as what they are", () => {
        const entries = chain(
            messageEntry(user("make the parser skip empty lines")),
            messageEntry(
                assistant([text("here it is"), toolCall("c1", "edit", { path: "/a.ts" })], { stopReason: "toolUse" }),
            ),
            messageEntry(toolResult("c1", "edit", "written", { details: { diff: "- 1 old\n+ 1 new" } })),
            messageEntry(bashExecution("ls", "one\ntwo")),
            {
                type: "compaction",
                timestamp: "2026-01-01T00:00:00.000Z",
                summary: "a summary",
                firstKeptEntryId: "e1",
                tokensBefore: 10,
            },
            messageEntry(user("and after the compaction")),
        );

        render(<>{transcript(entries)}</>);

        expect(screen.getByText("make the parser skip empty lines")).toBeInTheDocument();
        expect(screen.getByText("here it is")).toBeInTheDocument();
        // The diff of the edit is inside the card of the call it answers, and the
        // call is part of the answer that made it: the card of the call is the one
        // the entry and the call id name (the second entry, its first call).
        const edit = screen.getByText("new").closest("#e2-c1");
        expect(edit).not.toBeNull();
        expect(within(edit as globalThis.HTMLElement).getByLabelText("Succeeded")).toBeInTheDocument();
        // A command the reader ran is a card of its own, with pi's prompt on it.
        expect(screen.getByText("$")).toBeInTheDocument();
        expect(screen.getByText("ls")).toBeInTheDocument();
        expect(screen.getByText("[compaction]")).toBeInTheDocument();
        expect(screen.getByText("and after the compaction")).toBeInTheDocument();
    });

    it("draws a message that waits, with the queue it waits in", () => {
        render(
            <TranscriptEntry
                row={{ kind: "queued", id: "queued-steer-0", text: "run the tests first", queue: "steer" }}
            />,
        );

        expect(screen.getByText("run the tests first")).toBeInTheDocument();
        expect(screen.getByText("queued · steer")).toBeInTheDocument();
    });
});
