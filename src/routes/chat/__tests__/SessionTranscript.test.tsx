import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRow } from "@/lib/transcript";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

/**
 * The list drives virtua through its handle, hears it through `onScroll`,
 * `onResize` and `onScrollEnd`, and scrolls the scroll area's own viewport. The
 * mock stands in for virtua, so a test can say where a jump landed, when
 * virtua learned a new size, and - because the pill's jump is a run of frames and
 * not a cut - where the scroller was part way there.
 *
 * Frames are the test's to hand out: `requestAnimationFrame` is stubbed below, so
 * a glide runs only as far as a test lets it.
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

/** The scroller's own position, standing in for happy-dom's layout-less one. */
const box = { top: 0 };

const spies: {
    onScroll?: (offset: number) => void;
    onResize?: () => void;
    onScrollEnd?: () => void;
    props?: { bufferSize?: number; itemSize?: number };
} = {};

/** The end of the mock's list, as the list itself computes it. */
const END = handle.scrollSize - handle.viewportSize;

const frames = new Map<number, (now: number) => void>();
let frameId = 1;
let clock = 0;

/** Hand the waiting frames their next moment, `ms` after the last one. */
const frame = (ms = 16) => {
    clock += ms;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
        for (const run of queued) run(clock);
    });
};

vi.mock("virtua", () => ({
    Virtualizer: ({
        children,
        data,
        scrollRef,
        bufferSize,
        itemSize,
        onScroll,
        onResize,
        onScrollEnd,
        ref,
    }: {
        children: (row: TranscriptRow) => ReactNode;
        data: TranscriptRow[];
        scrollRef?: RefObject<HTMLElement | null>;
        bufferSize?: number;
        itemSize?: number;
        onScroll?: (offset: number) => void;
        onResize?: () => void;
        onScrollEnd?: () => void;
        ref?: RefObject<unknown>;
    }) => {
        spies.props = { bufferSize, itemSize };
        spies.onScroll = onScroll;
        spies.onResize = onResize;
        spies.onScrollEnd = onScrollEnd;
        useLayoutEffect(() => {
            if (ref) ref.current = handle;
            // happy-dom lays nothing out, so the scroller's position is the test's
            // own; what the list writes there is what it is read back from. The
            // scroller is the scroll area's viewport, which the list hands virtua.
            const el = scrollRef?.current ?? null;
            if (el) {
                Object.defineProperty(el, "scrollTop", {
                    get: () => box.top,
                    set: (value: number) => {
                        box.top = value;
                    },
                    configurable: true,
                });
            }
        });
        return <div>{data.map(children)}</div>;
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

// The list hears where it stands, and it really stands there: the scroller is the same one
// the harness writes to.
const land = (offset: number) =>
    act(() => {
        box.top = offset;
        spies.onScroll?.(offset);
    });
/** The reader at the end, who then takes the list back up it: the pill stands. */
const leftTheEnd = () => {
    land(END);
    land(0);
};
const sized = () => act(() => spies.onResize?.());
/** The pin a size change asks for is a microtask: hand it its turn, where a frame would not. */
const pinned = () =>
    act(async () => {
        await Promise.resolve();
    });
const settled = () => act(() => spies.onScrollEnd?.());
// The reader's own hand is heard on the region around the scroller, not on the
// scroller the list hands virtua. A wheel that way is a wheel back up the list.
const wheeled = (container: HTMLElement, deltaY = -100) =>
    act(() => fireEvent.wheel(container.firstElementChild as HTMLElement, { deltaY }));

const show = (overrides: Partial<Parameters<typeof SessionTranscript>[0]> = {}) =>
    render(<SessionTranscript rows={rows(30)} {...overrides} />);

const pill = (container: HTMLElement) => container.querySelector<HTMLButtonElement>("#transcript-jump");

/**
 * How the engine answers the reduced-motion query. The pill's glide is motion, and
 * a reader who asked for less of it is sent to the end at once - which is also the
 * case a test that wants the glide has to turn off.
 */
function motion(reduce: boolean) {
    vi.spyOn(window, "matchMedia").mockReturnValue({
        matches: reduce,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    } as unknown as MediaQueryList);
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
    handle.scrollToIndex.mockClear();
    spies.onScroll = undefined;
    spies.onResize = undefined;
    spies.onScrollEnd = undefined;
    spies.props = undefined;
    box.top = 0;
    frames.clear();
    frameId = 1;
    clock = 0;
    vi.stubGlobal("requestAnimationFrame", (run: (now: number) => void) => {
        const id = frameId++;
        frames.set(id, run);
        return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
        frames.delete(id);
    });
});

describe("SessionTranscript", () => {
    it("leaves the size of a row to virtua, and draws ahead of the reader", () => {
        // A size of pie's own would turn off the library's estimate of unmeasured
        // rows, which is what these rows need; the buffer is what a fast scroll draws
        // from before it is asked.
        show();

        expect(spies.props?.itemSize).toBeUndefined();
        expect(spies.props?.bufferSize).toBeGreaterThan(0);
    });

    it("keeps the place a reader wheeled back to while the run writes", () => {
        const view = show();
        land(END); // our jump landed, and the reader is reading from the end
        view.rerender(<SessionTranscript rows={rows(31)} />);
        handle.scrollToIndex.mockClear();

        // One notch of the wheel back up the list. The pin has to let go here and now:
        // the frame after this one writes another row, and the pin's own seek would
        // land after the reader's wheel and drag them to the end they left.
        wheeled(view.container);
        land(END - 60);
        view.rerender(<SessionTranscript rows={rows(32)} />);

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
        expect(pill(view.container)).not.toBeNull();
    });

    it("keeps it when the bar was dragged instead of the wheel turned", () => {
        const view = show();
        land(END);
        view.rerender(<SessionTranscript rows={rows(31)} />);
        handle.scrollToIndex.mockClear();

        // A drag of the bar hears no wheel: what says the reader is reading is the
        // list moving back up, however far it went.
        land(END - 60);
        view.rerender(<SessionTranscript rows={rows(32)} />);

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("does not take the end back while the reader is still on their way up", () => {
        const view = show();
        land(END);
        view.rerender(<SessionTranscript rows={rows(31)} />);
        handle.scrollToIndex.mockClear();

        // One notch of the wheel, still inside the band that counts as the end: the run
        // must not read that as the reader having arrived back, or the frame after this
        // one drags them to where they were going anyway.
        wheeled(view.container);
        land(END - 10);
        view.rerender(<SessionTranscript rows={rows(32)} />);

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("does not take the end from a scroll that only a measurement moved", () => {
        const view = show();
        land(END);
        view.rerender(<SessionTranscript rows={rows(31)} />);
        wheeled(view.container); // up: the reader has the list
        land(END - 60);

        // A row is measured, virtua keeps the view still, and that shift happens to leave the
        // list at the end. Nobody scrolled there: the run must not take it back from it.
        sized();
        land(END);
        handle.scrollToIndex.mockClear();
        view.rerender(<SessionTranscript rows={rows(32)} />);

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("takes the end back from a wheel that goes down onto it", () => {
        const view = show();
        land(END);
        view.rerender(<SessionTranscript rows={rows(31)} />);
        wheeled(view.container);
        land(END - 60);
        sized(); // a measurement moves the list: on its own that is not the reader coming back
        handle.scrollToIndex.mockClear();

        wheeled(view.container, 100); // down, and onto the end
        land(END);
        view.rerender(<SessionTranscript rows={rows(32)} />);

        // They asked for the end with their own hand, so what they land on is theirs to keep.
        expect(handle.scrollToIndex).toHaveBeenCalledWith(31, { align: "end" });
    });

    it("takes the end again once the reader comes back to it", () => {
        const view = show();
        land(END);
        view.rerender(<SessionTranscript rows={rows(31)} />);
        wheeled(view.container);
        land(END - 60); // the wheel moved the list back, and the run writes on without it

        // Back at the end, of their own accord: the run follows it again.
        land(END);
        handle.scrollToIndex.mockClear();
        view.rerender(<SessionTranscript rows={rows(32)} />);

        expect(handle.scrollToIndex).toHaveBeenCalledWith(31, { align: "end" });
    });

    it("follows the end from the first frame, and again whenever a row changes", () => {
        const view = show();
        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });

        handle.scrollToIndex.mockClear();
        view.rerender(<SessionTranscript rows={rows(31)} />);
        expect(handle.scrollToIndex).toHaveBeenCalledWith(30, { align: "end" });
    });

    it("takes the jump again while the sizes settle under it", async () => {
        // A jump lands where the sizes known at the time put the end; a row drawn for
        // the first time (or a rewrapped one) moves the end, and the reader who asked
        // for the end has to be brought to where it went.
        show();
        handle.scrollToIndex.mockClear();

        land(END - 300); // our own landing, short of a moved end
        sized();

        // Not in the observer's own delivery: the pin waits a microtask, so the frame the
        // reader is shown is the frame the end is already at.
        expect(handle.scrollToIndex).not.toHaveBeenCalled();
        await pinned();

        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });

    it("gives the end up when the reader scrolled a screen away from it", async () => {
        show();
        handle.scrollToIndex.mockClear();

        leftTheEnd();
        sized();
        await pinned();

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("stops taking the jump once it has arrived", async () => {
        show();
        land(END);
        handle.scrollToIndex.mockClear();

        sized();
        await pinned();

        // Still at the end, so a size that moves the end is followed - and a reader
        // who has to be somewhere else is served by the pill once they move.
        expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);

        leftTheEnd();
        handle.scrollToIndex.mockClear();
        sized();
        await pinned();
        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("runs the jump to the end instead of cutting to it", async () => {
        motion(false);
        const view = show();
        leftTheEnd();
        handle.scrollToIndex.mockClear();

        await act(async () => pill(view.container)?.click());

        // The click itself must not teleport: the rows between have to be drawn, so
        // that the heights the end is computed from are read off them and not guessed.
        expect(box.top).toBe(0);
        frame(200); // the first frame is where the run starts counting
        expect(box.top).toBe(0);
        frame(200);
        expect(box.top).toBeGreaterThan(0);
        expect(box.top).toBeLessThan(END);

        frame(200);
        frame(200);

        expect(box.top).toBe(END);
        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });

    it("keeps the pill away while its own run is still going", async () => {
        motion(false);
        const view = show();
        leftTheEnd();

        await act(async () => pill(view.container)?.click());
        expect(pill(view.container)).toBeNull();

        frame(100); // the run is under way
        land(300); // and the list hears its own scroll part way there

        expect(pill(view.container)).toBeNull();
    });

    it("jumps at once where the reader asked for less motion", async () => {
        motion(true);
        const view = show();
        leftTheEnd();
        handle.scrollToIndex.mockClear();

        const jump = pill(view.container);
        expect(jump).not.toBeNull();
        await act(async () => jump?.click());

        expect(box.top).toBe(0);
        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });

    it("lets the reader take the jump back", async () => {
        motion(false);
        const view = show();
        leftTheEnd();
        handle.scrollToIndex.mockClear();

        await act(async () => pill(view.container)?.click());
        frame(100);
        const part = box.top;
        wheeled(view.container);
        frame(200);
        frame(200);

        expect(box.top).toBe(part);
        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("takes the end again once the glide's scroll has settled", async () => {
        motion(false);
        const view = show();
        leftTheEnd();

        await act(async () => pill(view.container)?.click());
        frame(200);
        frame(200);
        frame(200);
        handle.scrollToIndex.mockClear();

        // Whatever a row measured while the glide ran, the end it landed on is read
        // once more where the scroll stops.
        settled();

        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });
});
