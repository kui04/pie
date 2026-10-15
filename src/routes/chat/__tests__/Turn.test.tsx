import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
        expect(screen.queryByText("let me look")).toBeNull();
    });

    it("does not fold a turn of one row", () => {
        renderTurn(oneCall(Date.parse(AT), 5200));

        // No heading, no rail: the row stands on its own, exactly as it stands inside a fold.
        expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull();
        expect(screen.getByText("pnpm test")).toBeInTheDocument();
    });

    it("keeps a live turn open, and folds it when its answer lands", () => {
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
        expect(screen.queryByText("/a.ts")).toBeNull();
    });

    it("lets the reader's own toggle outrank the fold's rule", () => {
        renderTurn(oneCall(Date.parse(AT), 5200));

        const row = screen.getByRole("button", { name: /pnpm test/ });
        fireEvent.click(row);
        expect(screen.getByText("36 passed")).toBeInTheDocument();
        fireEvent.click(row);
        expect(screen.queryByText("36 passed")).toBeNull();
    });

    it("stands the model's prose past the rail once the turn is folded", () => {
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

        // A thought and a call open the fold; the prose that stayed inside it stands with them.
        fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
        const grouped = screen.getByText("let me look");
        expect(grouped.closest("div.pl-8")).not.toBeNull();
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
