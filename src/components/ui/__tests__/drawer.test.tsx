/**
 * The wrapper over vaul, and the four things this copy does differently from the
 * registry's: the frame's hairline, the scrim the caller names, no width of its own
 * on a side drawer, and no type on a title or a description.
 *
 * A wrapper *is* its contract, so the contract is what these pin. The surfaces that
 * use it — the session sheet, the host-key prompt — are tested by their behaviour
 * instead, so that a change here fails here and not in them.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";

afterEach(cleanup);

const noop = () => undefined;

const contentOf = () => {
    const content = document.querySelector("[data-slot=drawer-content]");
    if (!content) throw new Error("no drawer content");
    return content;
};

const classOf = () => contentOf().className;

describe("DrawerContent", () => {
    it("runs the window's width and rounds only the top when it comes from the bottom", () => {
        render(
            <Drawer open onOpenChange={noop} direction="bottom">
                <DrawerContent>body</DrawerContent>
            </Drawer>,
        );

        // A sheet is the window's own bottom edge: inset to both sides, rounded where
        // only the window is not, and nothing centring it.
        expect(classOf()).toContain("data-[vaul-drawer-direction=bottom]:inset-x-0");
        expect(classOf()).toContain("data-[vaul-drawer-direction=bottom]:rounded-t-xl");
        expect(classOf()).not.toContain("mx-auto");
    });

    it("leaves a side drawer's width to its caller", () => {
        render(
            <Drawer open onOpenChange={noop} direction="left">
                <DrawerContent className="w-72">body</DrawerContent>
            </Drawer>,
        );

        // The registry's `w-3/4` would outrank the caller's own width: a variant beats
        // a plain utility whichever order the two are written in.
        expect(classOf()).not.toContain("w-3/4");
        expect(classOf()).toContain("data-[vaul-drawer-direction=left]:rounded-r-xl");
    });

    it("takes the scrim from the caller", () => {
        render(
            <Drawer open onOpenChange={noop} direction="bottom">
                <DrawerContent overlayClassName="bg-surface-container-highest/70">body</DrawerContent>
            </Drawer>,
        );

        expect(document.querySelector("[data-slot=drawer-overlay]")?.className).toContain(
            "bg-surface-container-highest/70",
        );
    });

    it("holds the grab bar under the sheet's edge, inside any padding the caller set", () => {
        render(
            <Drawer open onOpenChange={noop} direction="bottom">
                <DrawerContent className="px-6 pb-6">body</DrawerContent>
            </Drawer>,
        );

        const bar = contentOf().querySelector(":scope > div");
        // The bar's own `my-4` is the sheet's top gap, so it is the one thing a
        // caller's padding must not push down: a content padded at the top would
        // hang the bar 40px under the edge.
        expect(bar?.className).toContain("mx-auto");
        expect(bar?.className).toContain("my-4");
        expect(bar?.className).not.toContain("mt-4");
    });

    it("names a colour on a title and a description, never a size or a weight", () => {
        render(
            <Drawer open onOpenChange={noop} direction="bottom">
                <DrawerContent>
                    <DrawerTitle className="text-body-md">Trust this host?</DrawerTitle>
                    <DrawerDescription className="text-body-md text-muted-foreground">never seen</DrawerDescription>
                </DrawerContent>
            </Drawer>,
        );

        // `cn` reads the app's own `text-body-md` as a colour, so a size written here
        // would survive beside it and the stylesheet, not the call site, would decide
        // which one wins. The call site's ramp is the only size a title has.
        expect(document.querySelector("[data-slot=drawer-title]")?.className).not.toMatch(/\btext-(sm|base|lg|xl)\b/);
        expect(document.querySelector("[data-slot=drawer-description]")?.className).not.toMatch(
            /\btext-(sm|base|lg|xl)\b/,
        );
    });
});
