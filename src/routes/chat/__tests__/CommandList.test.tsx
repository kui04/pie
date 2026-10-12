import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Popover, PopoverAnchor } from "@/components/ui";
import { CommandList } from "@/routes/chat/composer/CommandList";
import type { CommandRow } from "@/routes/chat/composer/command";

/**
 * The scroll is what the list does for a highlight the message box moved: happy-dom
 * lays nothing out, so the call is read here rather than the scroll position.
 */
const scrolled: Element[] = [];

beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
    };
});

const rows = (count: number): CommandRow[] =>
    Array.from({ length: count }, (_, index) => ({
        id: `row-${index}`,
        name: `row-${index}`,
        description: null,
    }));

const show = (highlighted: string) => (
    // The panel is a popover content, so a root stands around it: the box is its
    // anchor, which a test does not lay out.
    <Popover open>
        <PopoverAnchor asChild>
            <span>the box</span>
        </PopoverAnchor>
        <CommandList
            id="menu"
            rows={rows(20)}
            highlighted={highlighted}
            onHighlight={() => undefined}
            onChoose={() => undefined}
        />
    </Popover>
);

describe("CommandList", () => {
    it("keeps the row under the keyboard in view, from the first draw on", () => {
        render(show("row-1"));

        expect(scrolled[scrolled.length - 1]?.textContent).toContain("/row-1");
    });

    it("follows the highlight the message box moves, and stands still when it does not move", () => {
        const { rerender } = render(show("row-1"));
        const drawn = scrolled.length;

        rerender(show("row-1"));
        expect(scrolled.length).toBe(drawn);

        rerender(show("row-12"));
        expect(scrolled[scrolled.length - 1]?.textContent).toContain("/row-12");
    });
});
