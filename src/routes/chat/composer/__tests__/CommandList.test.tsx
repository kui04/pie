import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Popover, PopoverTrigger } from "@/components/ui";
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

const show = (highlighted: string, count = 20) => (
    // The panel is a popover content, so a root stands around it: the box is its
    // trigger, which a test does not lay out.
    <Popover open>
        <PopoverTrigger render={<span />} nativeButton={false}>
            the box
        </PopoverTrigger>
        <CommandList
            id="menu"
            rows={rows(count)}
            highlighted={highlighted}
            lit="row-1"
            onPoint={() => undefined}
            onChoose={() => undefined}
        />
    </Popover>
);

describe("CommandList", () => {
    it("is as tall as ten rows when there are more of them, and as tall as its rows when not", () => {
        // A panel that is taller than its rows is ten rows of air; one that is taller than
        // the ten it shows hides the rest, because the scroll area takes its height from
        // the panel and a capped parent leaves it as tall as its content.
        const { rerender } = render(show("row-1"));
        expect(document.querySelector("#menu")).toHaveClass("h-103");

        rerender(show("row-1", 3));
        expect(document.querySelector("#menu")).not.toHaveClass("h-103");
    });

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
