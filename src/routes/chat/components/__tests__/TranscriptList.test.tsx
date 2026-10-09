import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRow } from "@/lib/transcript";
import { TranscriptList } from "@/routes/chat/components/TranscriptList";

/**
 * The list drives virtua through its handle and hears it through `onScroll` and
 * `onResize`. The mock stands in for both, so a test can say where a jump landed
 * and when virtua learned a new size - which is the whole of what the list tells
 * the list to do.
 */

interface Handle {
    viewportSize: number;
    scrollSize: number;
    scrollOffset: number;
    scrollToIndex: ReturnType<typeof vi.fn>;
}

const handle: Handle = {
    viewportSize: 600,
    scrollSize: 2000,
    scrollOffset: 0,
    scrollToIndex: vi.fn(),
};

const spies: { onScroll?: (offset: number) => void; onResize?: () => void } = {};

/** The end of the mock's list, as the list itself computes it. */
const END = handle.scrollSize - handle.viewportSize;

vi.mock("virtua", () => ({
    VList: ({
        children,
        data,
        id,
        onScroll,
        onResize,
        ref,
    }: {
        children: (row: TranscriptRow) => ReactNode;
        data: TranscriptRow[];
        id?: string;
        onScroll?: (offset: number) => void;
        onResize?: () => void;
        ref?: RefObject<unknown>;
    }) => {
        spies.onScroll = onScroll;
        spies.onResize = onResize;
        useLayoutEffect(() => {
            if (ref) ref.current = handle;
        });
        return <div id={id}>{data.map(children)}</div>;
    },
}));

const rows = (count: number): TranscriptRow[] =>
    Array.from({ length: count }, (_, i) => ({
        kind: "notice",
        id: `notice-${i}`,
        label: `[row ${i}]`,
        summary: `Row ${i}`,
        body: null,
    }));

const land = (offset: number) => act(() => spies.onScroll?.(offset));
const sized = () => act(() => spies.onResize?.());

const show = (overrides: Partial<Parameters<typeof TranscriptList>[0]> = {}) =>
    render(<TranscriptList rows={rows(30)} clearance={144} {...overrides} />);

beforeEach(() => {
    handle.scrollToIndex.mockClear();
    spies.onScroll = undefined;
    spies.onResize = undefined;
});

describe("TranscriptList", () => {
    it("follows the end from the first frame, and again whenever a row changes", () => {
        const view = show();
        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });

        handle.scrollToIndex.mockClear();
        view.rerender(<TranscriptList rows={rows(31)} clearance={144} />);
        expect(handle.scrollToIndex).toHaveBeenCalledWith(30, { align: "end" });
    });

    it("takes the jump again while the sizes settle under it", () => {
        // A jump lands where the sizes known at the time put the end; a row drawn for
        // the first time (or a rewrapped one) moves the end, and the reader who asked
        // for the end has to be brought to where it went.
        show();
        handle.scrollToIndex.mockClear();

        land(END - 300); // our own landing, short of a moved end
        sized();

        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });

    it("gives the end up when the reader scrolled a screen away from it", () => {
        show();
        handle.scrollToIndex.mockClear();

        land(0); // the reader left
        sized();

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("stops taking the jump once it has arrived", () => {
        show();
        land(END);
        handle.scrollToIndex.mockClear();

        sized();

        // Still at the end, so a size that moves the end is followed - and a reader
        // who has to be somewhere else is served by the pill once they move.
        expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);

        land(0);
        handle.scrollToIndex.mockClear();
        sized();
        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("pads itself by the band, and moves with it", () => {
        const view = show({ clearance: 96 });
        handle.scrollToIndex.mockClear();

        view.rerender(<TranscriptList rows={rows(30)} clearance={240} />);

        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });

    it("jumps to the end from the pill", async () => {
        const view = show();
        land(0);
        handle.scrollToIndex.mockClear();

        const pill = view.container.querySelector<HTMLButtonElement>("#transcript-jump");
        expect(pill).not.toBeNull();
        await act(async () => pill?.click());

        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });
});
