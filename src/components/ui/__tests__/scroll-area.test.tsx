import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The places this file departs from what the registry ships, pinned so an
 * upstream re-merge has to argue with a test rather than slip through: pie draws
 * one bar, and it is the design's own pill rather than the registry's.
 *
 * The colour of the pill itself is a style of the thumb, which the engine draws
 * only when a region really overflows - so it is checked where it can be seen
 * (WebKitGTK measures `--outline`) and pinned in DESIGN.md, not here.
 */

const bar = (container: HTMLElement) => container.querySelector("[data-slot=scroll-area-scrollbar]");

describe("ScrollArea", () => {
    it("keeps the design's 8px lane, holding a 4px pill", () => {
        const { container } = render(<ScrollArea type="always">a row</ScrollArea>);

        // One lane, one pill, one inset - named per orientation, because a log
        // scrolls sideways and a transcript down and both bars are this design.
        const classes = bar(container)?.className.split(" ") ?? [];
        expect(classes).toContain("data-vertical:w-2");
        expect(classes).toContain("data-vertical:px-0.5");
        expect(classes).toContain("data-horizontal:h-2");
        expect(classes).toContain("data-horizontal:py-0.5");
    });

    it("draws only the bars an area can need", () => {
        const sideways = render(
            <ScrollArea bars="horizontal" type="always">
                a row
            </ScrollArea>,
        );
        const bars = [...sideways.container.querySelectorAll("[data-slot=scroll-area-scrollbar]")];

        // A table needs the sideways one and nothing to stand in its own column.
        expect(bars.map((element) => element.getAttribute("data-orientation"))).toEqual(["horizontal"]);
    });

    it("scrolls the viewport, and lets the caller name it", () => {
        const { container } = render(<ScrollArea viewportClassName="pt-2">a row</ScrollArea>);

        // The viewport is inside Radix's own Root, so a class from the call site
        // can only reach it through this prop.
        expect(container.querySelector("[data-radix-scroll-area-viewport]")?.className).toContain("pt-2");
    });
});
