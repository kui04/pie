import { type ReactNode, type RefObject } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRow } from "@/lib/transcript";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

/**
 * virtua draws nothing under happy-dom, so it stands in here, and keeps what the list
 * handed it.
 */

interface Handed {
    scrollRef?: RefObject<HTMLElement | null>;
    bufferSize?: number;
    itemSize?: number;
    count?: number;
    onResize?: () => void;
}

const handed: Handed = {};

vi.mock("virtua", () => ({
    Virtualizer: ({
        children,
        data,
        scrollRef,
        bufferSize,
        itemSize,
        onResize,
    }: {
        children: (row: TranscriptRow) => ReactNode;
        data: TranscriptRow[];
        scrollRef?: RefObject<HTMLElement | null>;
        bufferSize?: number;
        itemSize?: number;
        onResize?: () => void;
    }) => {
        handed.scrollRef = scrollRef;
        handed.bufferSize = bufferSize;
        handed.itemSize = itemSize;
        handed.count = data.length;
        handed.onResize = onResize;
        // The library's own container: the rows stand in a box of their own inside the
        // region, never among the region's children.
        return <div data-slot="virtua">{data.map((row) => children(row))}</div>;
    },
}));

const rows = (count: number): TranscriptRow[] =>
    Array.from({ length: count }, (_, i) => ({
        kind: "skill",
        id: `skill-${i}`,
        summary: `Row ${i}`,
        body: null,
    }));

const show = (overrides: Partial<Parameters<typeof SessionTranscript>[0]> = {}) =>
    render(<SessionTranscript rows={rows(30)} {...overrides} />);

const slot = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-slot="${name}"]`);

beforeEach(() => {
    handed.scrollRef = undefined;
    handed.bufferSize = undefined;
    handed.itemSize = undefined;
    handed.count = undefined;
    handed.onResize = undefined;
});

describe("SessionTranscript", () => {
    it("leaves the size of a row to virtua, and draws ahead of the reader", () => {
        // A size of pie's own would turn off the library's estimate of unmeasured rows,
        // which is what these rows need; the buffer is what a fast scroll draws from.
        show();

        expect(handed.itemSize).toBeUndefined();
        expect(handed.bufferSize).toBeGreaterThan(0);
    });

    it("scrolls the region the scroller owns, and no region of its own", () => {
        // The rows must be measured against the element that scrolls, and that element
        // belongs to the scroller, inside the pane whose bar reads it.
        const view = show();
        const viewport = slot(view.container, "message-scroller-viewport");

        expect(handed.scrollRef?.current).toBe(viewport);
        expect(handed.scrollRef?.current).not.toBe(slot(view.container, "virtua"));
        expect(slot(view.container, "scroll-area")).toContainElement(viewport);
    });

    it("stands in the region the scroller owns", () => {
        const view = show();

        expect(slot(view.container, "message-scroller")).toContainElement(slot(view.container, "virtua"));
        expect(slot(view.container, "message-scroller-viewport")).toContainElement(slot(view.container, "virtua"));
    });

    it("draws one entry per row, and only as many as the list is given", () => {
        const view = show();

        expect(handed.count).toBe(30);
        expect(view.getByText("Row 0")).toBeInTheDocument();
        expect(view.getByText("Row 29")).toBeInTheDocument();
    });

    it("hands the transcript to the reader of the whole run", () => {
        // A labelled region, and a log that announces what is added to it.
        const view = show();
        const viewport = slot(view.container, "message-scroller-viewport");
        const content = slot(view.container, "message-scroller-content");

        expect(viewport).toHaveAttribute("role", "region");
        expect(viewport).toHaveAttribute("aria-label");
        // The tab stop belongs to `scroll-area`, which keeps a region with nothing to scroll
        // out of it: nothing is laid out here, so this is the region that has nothing.
        expect(viewport).toHaveAttribute("tabindex", "-1");
        expect(content).toHaveAttribute("role", "log");
    });

    it("holds the additions of a run that is still writing", () => {
        // A log announces what is added to it, and an answer arrives part by part: without
        // this, a screen reader would read one answer as it grows, and read it again once it
        // is whole. A session that stands still is not busy.
        const writing = slot(show({ working: true }).container, "message-scroller-content");
        const still = slot(show().container, "message-scroller-content");

        expect(writing).toHaveAttribute("aria-busy", "true");
        expect(still).not.toHaveAttribute("aria-busy");
    });

    it("keeps the end in view when the keyboard shrinks the region", () => {
        const view = show();
        const viewport = slot(view.container, "message-scroller-viewport") as HTMLElement;
        Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
        Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });

        view.rerender(<SessionTranscript rows={rows(30)} viewportHeight={400} />);

        expect(viewport.scrollTop).toBe(1000);
    });

    it("re-anchors to the end when virtua measures item heights", () => {
        const view = show();
        const viewport = slot(view.container, "message-scroller-viewport") as HTMLElement;
        Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 5000 });
        Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });

        expect(handed.onResize).toBeTypeOf("function");
        handed.onResize?.();

        expect(viewport.scrollTop).toBe(5000);
    });

    it("shows the list as soon as the end it opens at is applied", () => {
        // The region stays out of sight until that position is written: a list left
        // pending is a blank screen.
        const view = show();

        expect(slot(view.container, "message-scroller-viewport")).not.toHaveAttribute("data-pending-scroll");
    });

    it("keeps the way back to the end out of the reader's way while the list is at it", () => {
        const view = show();
        const jump = view.container.querySelector<HTMLButtonElement>("#transcript-jump");

        expect(jump).not.toBeNull();
        expect(jump).toHaveAttribute("data-active", "false");
        expect(jump).toHaveAttribute("inert");
        expect(jump).toHaveAttribute("tabindex", "-1");
        expect(jump).toHaveAttribute("aria-label", "To bottom");
    });

    it("draws the pane's own bar over the region", () => {
        // The bar is the one every pane has, and it reads the region through the element
        // the scroller brought: no second bar of pie's own, and none of the engine's.
        const view = show();

        expect(slot(view.container, "scroll-area-scrollbar")).not.toBeNull();
        expect(slot(view.container, "scroll-area")).toContainElement(slot(view.container, "scroll-area-scrollbar"));
    });
});
