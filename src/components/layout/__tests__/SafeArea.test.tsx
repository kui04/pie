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

function inset(element: Element | null, side: "top" | "right" | "bottom" | "left"): string {
    return element instanceof HTMLElement ? element.style.getPropertyValue(`--safe-area-${side}`) : "";
}

describe("SafeArea", () => {
    it("keeps both ends of a column by default", () => {
        const { container } = render(<SafeArea id="panel" />);
        const panel = container.querySelector("#panel");

        expect(inset(panel, "top")).toBe("env(safe-area-inset-top, 0px)");
        expect(inset(panel, "bottom")).toBe("env(safe-area-inset-bottom, 0px)");
        expect(inset(panel, "left")).toBe("");
        expect(inset(panel, "right")).toBe("");
        expect(panel instanceof HTMLElement ? panel.style.paddingTop : "").toBe("var(--safe-area-top)");
        expect(panel instanceof HTMLElement ? panel.style.paddingBottom : "").toBe("var(--safe-area-bottom)");
    });

    it("keeps the side it is asked for, and no other", () => {
        const top = render(<SafeArea id="bar" side="top" />);
        expect(inset(top.container.querySelector("#bar"), "top")).toBe("env(safe-area-inset-top, 0px)");
        expect(inset(top.container.querySelector("#bar"), "bottom")).toBe("");
        top.unmount();

        const bottom = render(<SafeArea id="band" side="bottom" />);
        expect(inset(bottom.container.querySelector("#band"), "bottom")).toBe("env(safe-area-inset-bottom, 0px)");
        expect(inset(bottom.container.querySelector("#band"), "top")).toBe("");
        bottom.unmount();

        const all = render(<SafeArea id="screen" side="all" />);
        expect(inset(all.container.querySelector("#screen"), "left")).toBe("env(safe-area-inset-left, 0px)");
        expect(inset(all.container.querySelector("#screen"), "right")).toBe("env(safe-area-inset-right, 0px)");
    });

    it("is the caller's element in everything but the insets", () => {
        const { container } = render(
            <SafeArea
                id="list"
                side="vertical"
                className="flex flex-col bg-surface-dim"
                style={{ color: "red" }}
                data-testid="probe"
            />,
        );

        const element = container.querySelector("#list");
        expect(element?.className).toContain("bg-surface-dim");
        expect(element?.className).toContain("flex");
        expect(element?.getAttribute("data-testid")).toBe("probe");
        expect(element instanceof HTMLElement ? element.style.color : "").toBe("red");
    });
});
