import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SafeArea } from "@/components/layout/SafeArea";

/**
 * The system bars are an environment fact the stylesheet resolves, so what is
 * pinned here is which sides a region asks for and that the element is otherwise
 * the caller's own. Whether the insets are non-zero is the engine's business: on
 * a phone they are the bars, on a desktop all four are zero.
 */

afterEach(cleanup);

describe("SafeArea", () => {
    it("keeps both ends of a column by default", () => {
        const { container } = render(<SafeArea id="panel" />);

        expect(container.querySelector("#panel")?.className).toContain("pt-safe");
        expect(container.querySelector("#panel")?.className).toContain("pb-safe");
    });

    it("keeps the side it is asked for, and no other", () => {
        const top = render(<SafeArea id="bar" side="top" />);
        expect(top.container.querySelector("#bar")?.className).toContain("pt-safe");
        expect(top.container.querySelector("#bar")?.className).not.toContain("pb-safe");
        top.unmount();

        const bottom = render(<SafeArea id="band" side="bottom" />);
        expect(bottom.container.querySelector("#band")?.className).toContain("pb-safe");
        expect(bottom.container.querySelector("#band")?.className).not.toContain("pt-safe");
        bottom.unmount();

        const all = render(<SafeArea id="screen" side="all" />);
        expect(all.container.querySelector("#screen")?.className).toContain("pl-safe");
        expect(all.container.querySelector("#screen")?.className).toContain("pr-safe");
    });

    it("is the caller's element in everything but the insets", () => {
        const { container } = render(
            <SafeArea id="list" side="vertical" className="flex flex-col bg-surface-dim" data-testid="probe" />,
        );

        const element = container.querySelector("#list");
        expect(element?.className).toContain("bg-surface-dim");
        expect(element?.className).toContain("flex");
        expect(element?.getAttribute("data-testid")).toBe("probe");
    });
});
