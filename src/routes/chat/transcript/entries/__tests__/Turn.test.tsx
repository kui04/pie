import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { transcriptRows } from "@/lib/transcript";
import {
    AT,
    assistant,
    chain,
    messageEntry,
    storeOf,
    text,
    thinking,
    toolCall,
    toolResult,
    user,
} from "@/preview/fixtures";
import { Turn } from "@/routes/chat/transcript/entries/Turn";
import { foldTurns } from "@/routes/chat/transcript/fold";

/** The turn a session's rows fold into, as the list draws it. */
function renderTurn(entries: ReturnType<typeof chain>, live = false) {
    const store = storeOf(entries);
    const rows = transcriptRows(store, store.order.length > 0 ? store.order[store.order.length - 1] : null);
    const slots = foldTurns(rows);
    const work = slots.find((slot) => slot.kind === "work");
    if (work === undefined || work.kind !== "work") throw new Error("no turn in these entries");
    render(
        <Turn id={work.key} facts={work.facts} items={work.items} answer={work.answer} note={work.note} live={live} />,
    );
    return work;
}

/** One call, answered, written the way pi writes them. */
const oneCall = (at: number, durationMs?: number) =>
    chain(
        messageEntry(user("run the tests", Date.parse(AT))),
        messageEntry(assistant([toolCall("c1", "bash", { command: "pnpm test" })], { timestamp: at })),
        messageEntry(toolResult("c1", "bash", "36 passed", durationMs === undefined ? {} : { durationMs })),
    );

describe("Turn", () => {
    it("folds a turn of several rows behind its heading", () => {
        renderTurn(
            chain(
                messageEntry(user("make the parser skip empty lines", Date.parse(AT))),
                messageEntry(
                    assistant(
                        [thinking("look first"), text("let me look"), toolCall("c1", "read", { path: "/a.ts" })],
                        { timestamp: Date.parse(AT) },
                    ),
                ),
                messageEntry(toolResult("c1", "read", "1 line")),
                messageEntry(assistant([text("done")], { timestamp: Date.parse(AT) })),
            ),
        );

        // The heading counts what the turn did, and the work waits behind it.
        expect(screen.getByRole("button", { name: /Worked for/ })).toBeInTheDocument();
        expect(screen.getByText("done")).toBeInTheDocument();
        // The prose is a row of the run: it is hidden by the fold like the rest.
        expect(screen.queryByText("let me look")).toBeNull();
    });

    it("does not fold a turn of one row", () => {
        renderTurn(oneCall(Date.parse(AT), 5200));

        // No heading, no rail: the row stands on its own, exactly as it stands inside a fold.
        expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull();
        expect(screen.getByText("pnpm test")).toBeInTheDocument();
    });

    it("keeps a live turn open, and folds it when its answer lands", async () => {
        const entries = chain(
            messageEntry(user("make the parser skip empty lines", Date.parse(AT))),
            messageEntry(
                assistant([thinking("look first"), toolCall("c1", "read", { path: "/a.ts" })], {
                    timestamp: Date.parse(AT),
                }),
            ),
            messageEntry(toolResult("c1", "read", "1 line")),
            messageEntry(assistant([text("done")], { timestamp: Date.parse(AT) })),
        );
        const store = storeOf(entries);
        const rows = transcriptRows(store, store.order[store.order.length - 1]);
        const work = foldTurns(rows).find((slot) => slot.kind === "work");
        if (work === undefined || work.kind !== "work") throw new Error("no turn");

        const { rerender } = render(
            <Turn id={work.key} facts={work.facts} items={work.items} answer={work.answer} note={work.note} live />,
        );
        expect(screen.getByText("/a.ts")).toBeInTheDocument();

        rerender(
            <Turn
                id={work.key}
                facts={work.facts}
                items={work.items}
                answer={work.answer}
                note={work.note}
                live={false}
            />,
        );
        await waitFor(() => expect(screen.queryByText("/a.ts")).toBeNull());
        expect(screen.getByText("done")).toBeInTheDocument();
        expect(document.querySelector('[id$="-answer"]')).not.toBeNull();
    });

    it("lets the reader's own toggle outrank the fold's rule", async () => {
        renderTurn(oneCall(Date.parse(AT), 5200));

        const row = screen.getByRole("button", { name: /pnpm test/ });
        fireEvent.click(row);
        expect(screen.getByText("36 passed")).toBeInTheDocument();
        fireEvent.click(row);
        await waitFor(() => expect(screen.queryByText("36 passed")).toBeNull());
    });

    it("draws a notice inside the fold as a row of its own kind", () => {
        // A skill arrives mid-run, after the assistant message that opened
        // the turn: the fold absorbs it behind its heading. (A compaction
        // always stands before the fold - the context puts it there.)
        renderTurn(
            chain(
                messageEntry(user("make the parser skip empty lines", Date.parse(AT))),
                messageEntry(
                    assistant([toolCall("c1", "read", { path: "/a.ts" })], {
                        timestamp: Date.parse(AT),
                    }),
                ),
                {
                    type: "custom_message",
                    timestamp: AT,
                    customType: "skill",
                    content: "the skill ran\n\nand kept notes",
                    display: true,
                },
                messageEntry(toolResult("c1", "read", "1 line")),
                messageEntry(assistant([text("done")], { timestamp: Date.parse(AT) })),
            ),
        );

        // The fold opens on the heading; the skill stands behind it as its
        // own row, and opens like one.
        fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
        const row = screen.getByRole("button", { name: /^Skill$/ });
        expect(row.closest("div.pl-8")).toBeNull();
        fireEvent.click(row);
        expect(screen.getByText("and kept notes")).toBeInTheDocument();
    });

    it("keeps the model's prose in its place in the timeline, without a fold", () => {
        renderTurn(
            chain(
                messageEntry(user("make the parser skip empty lines", Date.parse(AT))),
                messageEntry(
                    assistant([text("let me look"), toolCall("c1", "read", { path: "/a.ts" })], {
                        timestamp: Date.parse(AT),
                    }),
                ),
                messageEntry(toolResult("c1", "read", "1 line")),
                messageEntry(assistant([text("done")], { timestamp: Date.parse(AT) })),
            ),
        );

        fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
        const prose = screen.getByText("let me look");
        const row = prose.closest('[data-slot="marker"]');
        expect(row?.tagName).toBe("DIV");
        expect(row?.querySelector("button")).toBeNull();
        expect(row?.querySelector("svg.lucide-dot")).not.toBeNull();

        // It stands before the call it introduced, not after the whole fold.
        const call = screen.getByRole("button", { name: /\/a\.ts/ });
        expect(prose.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
    it("leaves the final answer plain, apart from the fold", () => {
        renderTurn(
            chain(
                messageEntry(user("make the parser skip empty lines", Date.parse(AT))),
                messageEntry(
                    assistant([toolCall("c1", "read", { path: "/a.ts" })], {
                        timestamp: Date.parse(AT),
                    }),
                ),
                messageEntry(toolResult("c1", "read", "1 line")),
                messageEntry(assistant([text("done")], { timestamp: Date.parse(AT) })),
            ),
        );

        const answer = document.querySelector('[id$="-answer"]');
        expect(answer).not.toBeNull();
        expect(answer?.querySelector("svg.lucide-dot")).toBeNull();
        expect(screen.getByText("done")).toBeInTheDocument();
    });
});

describe("Turn's rail", () => {
    it("runs through a fold, and a body inside it carries no line of its own", () => {
        renderTurn(
            chain(
                messageEntry(user("make the parser skip empty lines", Date.parse(AT))),
                messageEntry(
                    assistant([thinking("look first"), toolCall("c1", "read", { path: "/a.ts" })], {
                        timestamp: Date.parse(AT),
                    }),
                ),
                messageEntry(toolResult("c1", "read", "1 line")),
                messageEntry(assistant([text("done")], { timestamp: Date.parse(AT) })),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
        fireEvent.click(screen.getByRole("button", { name: /\/a\.ts/ }));

        // One line for the whole fold, none of its own for the body the fold already railed.
        expect(document.querySelectorAll("span.bg-divider")).toHaveLength(1);
    });

    it("gives a row that stands alone a line under itself, the way a quote carries one", () => {
        renderTurn(oneCall(Date.parse(AT), 5200));
        fireEvent.click(screen.getByRole("button", { name: /pnpm test/ }));

        const line = document.querySelector("span.bg-divider");
        expect(line).not.toBeNull();
        // It hangs inside the body, below the glyph, not through the row's own line.
        expect(line?.closest("div.pl-8")).not.toBeNull();
    });
});
