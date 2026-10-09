import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchScrollbars } from "@/lib/scrollbars";

const REVEALED = "is-scrolling";

const scrolling = (element: Element) => element.dispatchEvent(new Event("scroll", { bubbles: false }));

describe("watchScrollbars", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        watchScrollbars();
        document.body.innerHTML = "";
    });

    afterEach(() => {
        document.documentElement.classList.remove(REVEALED);
        vi.useRealTimers();
    });

    it("shows the bar when a region scrolls, and takes it away once it stops", () => {
        const region = document.createElement("div");
        document.body.append(region);

        scrolling(region);
        expect(document.documentElement.classList.contains(REVEALED)).toBe(true);

        vi.advanceTimersByTime(699);
        expect(document.documentElement.classList.contains(REVEALED)).toBe(true);

        vi.advanceTimersByTime(1);
        expect(document.documentElement.classList.contains(REVEALED)).toBe(false);
    });

    it("waits for the last scroll rather than the first", () => {
        const region = document.createElement("div");
        document.body.append(region);

        scrolling(region);
        vi.advanceTimersByTime(500);
        scrolling(region);
        vi.advanceTimersByTime(500);

        // The hold restarts from the scroll just made, not from the one before it.
        expect(document.documentElement.classList.contains(REVEALED)).toBe(true);
    });

    it("hears a region that does not bubble its scroll", () => {
        const region = document.createElement("div");
        const inner = document.createElement("span");
        region.append(inner);
        document.body.append(region);

        // `scroll` does not bubble, so only a capture-phase listener hears this
        // one - which is every region, including the ones not made yet.
        inner.dispatchEvent(new Event("scroll", { bubbles: false }));

        expect(document.documentElement.classList.contains(REVEALED)).toBe(true);
    });
});
