import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Panel } from "@/components/Panel";

/**
 * The component *is* the rule, so the rule is what these pin: a lone panel is
 * the window and has no chrome; a panel with a neighbour is a card, because that
 * hairline is the only thing telling the two apart.
 *
 * A bare `<section>` has no accessible name, so it carries no role to query by —
 * the id the frontend rule asks components to have is the hook here.
 */

afterEach(cleanup);

const panelById = (id: string) => {
    const panel = document.getElementById(id);
    if (!panel) throw new Error(`no panel with id \`${id}\``);
    return panel;
};

const chromeOf = (id: string) => {
    const className = panelById(id).className;
    return {
        margin: className.includes("m-1"),
        border: className.includes("border-border"),
        radius: className.includes("rounded-lg"),
    };
};

const NO_CHROME = { margin: false, border: false, radius: false };
const CARD = { margin: true, border: true, radius: true };

describe("Panel", () => {
    it("fills the edge to edge when it is the whole window", () => {
        render(<Panel id="stage" solo />);

        expect(chromeOf("stage")).toEqual(NO_CHROME);
        expect(panelById("stage").getAttribute("data-solo")).toBe("true");
    });

    it("reads as a card when it has a neighbour", () => {
        // The default is "there are others": a panel that forgot to say
        // otherwise would quietly lose its own edge against the window.
        render(<Panel id="stage" />);

        expect(chromeOf("stage")).toEqual(CARD);
        expect(panelById("stage").getAttribute("data-solo")).toBe("false");
    });

    it("gives every panel the same chrome when there are several", () => {
        // The count is the caller's to know, not the panel's: a panel cannot see
        // its siblings, and any of them may not be rendered at all.
        render(
            <>
                <Panel id="catalogue" />
                <Panel id="session" />
            </>,
        );

        expect(chromeOf("catalogue")).toEqual(CARD);
        expect(chromeOf("session")).toEqual(CARD);
    });

    it("keeps what the caller asked for, and shares the window", () => {
        render(<Panel id="stage" className="items-center" />);

        const panel = panelById("stage");
        expect(panel.className).toContain("items-center");
        expect(panel.className).toContain("bg-surface");
        // A pane is sized by what is beside it, so it flexes and sets no
        // dimension of its own.
        expect(panel.className).toContain("flex-1");
        expect(panel.className).toContain("min-w-0");
        expect(panel.className).not.toMatch(/w-\[|max-w-/);
    });
});
