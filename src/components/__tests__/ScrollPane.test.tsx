/**
 * The pane, and what makes it pie's rather than the registry's: one bar, mounted
 * for good, in the design's own lane, scrollable through a viewport a caller can
 * name.
 *
 * A pane *is* its contract, so the contract is what these pin. The screens that
 * use it - the transcript, the drawers, the code blocks - are tested by their
 * behaviour instead, so that a change here fails here and not in them.
 *
 * The colour of the pill itself is a style of the thumb, which the engine draws
 * only when a region really overflows - so it is checked where it can be seen
 * (WebKitGTK measures `--outline`) and pinned in DESIGN.md, not here.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollPane } from "@/components/ScrollPane";

afterEach(cleanup);

const bar = (container: HTMLElement) => container.querySelector("[data-slot=scroll-area-scrollbar]");

describe("ScrollPane", () => {
    it("keeps the design's 8px lane, holding a 4px pill", () => {
        const { container } = render(<ScrollPane>a row</ScrollPane>);

        // One lane, one pill, one inset - named per orientation, because a log
        // scrolls sideways and a transcript down and both bars are this design.
        const classes = bar(container)?.className.split(" ") ?? [];
        expect(classes).toContain("data-vertical:w-2");
        expect(classes).toContain("data-vertical:px-0.5");
        expect(classes).toContain("data-horizontal:h-2");
        expect(classes).toContain("data-horizontal:py-0.5");
    });

    it("mounts the bar before anyone points at the pane", () => {
        // The stylesheet fades this bar in and out, and a bar that only mounts
        // when the region overflows could not be faded: it would appear. The
        // bar stays mounted for that reason, and not the registry default.
        const { container } = render(<ScrollPane>a row</ScrollPane>);

        expect(bar(container)).not.toBeNull();
    });

    it("draws only the bars an area can need", () => {
        const sideways = render(<ScrollPane bars="horizontal">a row</ScrollPane>);
        const bars = [...sideways.container.querySelectorAll("[data-slot=scroll-area-scrollbar]")];

        // A table needs the sideways one and nothing to stand in its own column.
        expect(bars.map((element) => element.getAttribute("data-orientation"))).toEqual(["horizontal"]);
    });

    it("scrolls the viewport, and lets the caller name it", () => {
        const { container } = render(<ScrollPane viewportClassName="pt-2">a row</ScrollPane>);

        // The viewport is inside the scroll area's own Root, so a class from the
        // call site can only reach it through this prop.
        expect(container.querySelector("[data-slot=scroll-area-viewport]")?.className).toContain("pt-2");
    });
});
