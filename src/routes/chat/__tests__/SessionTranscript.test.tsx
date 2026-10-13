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
        onScroll,
        onResize,
        onScrollEnd,
        ref,
    }: {
        children: (row: TranscriptRow) => ReactNode;
        data: TranscriptRow[];
        scrollRef?: RefObject<HTMLElement | null>;
        onScroll?: (offset: number) => void;
        onResize?: () => void;
        onScrollEnd?: () => void;
        ref?: RefObject<unknown>;
    }) => {
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

const land = (offset: number) => act(() => spies.onScroll?.(offset));
const sized = () => act(() => spies.onResize?.());
const settled = () => act(() => spies.onScrollEnd?.());
// The reader's own hand is heard on the region around the scroller, not on the
// scroller the list hands virtua.
const wheeled = (container: HTMLElement) => act(() => fireEvent.wheel(container.firstElementChild as HTMLElement));

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
    it("follows the end from the first frame, and again whenever a row changes", () => {
        const view = show();
        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });

        handle.scrollToIndex.mockClear();
        view.rerender(<SessionTranscript rows={rows(31)} />);
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

        // Not in the observer's own delivery: a scroll written there is the loop the
        // browser reports as "undelivered notifications".
        expect(handle.scrollToIndex).not.toHaveBeenCalled();
        frame(16);

        expect(handle.scrollToIndex).toHaveBeenCalledWith(29, { align: "end" });
    });

    it("gives the end up when the reader scrolled a screen away from it", () => {
        show();
        handle.scrollToIndex.mockClear();

        land(0); // the reader left
        sized();
        frame(16);

        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("stops taking the jump once it has arrived", () => {
        show();
        land(END);
        handle.scrollToIndex.mockClear();

        sized();
        frame(16);

        // Still at the end, so a size that moves the end is followed - and a reader
        // who has to be somewhere else is served by the pill once they move.
        expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);

        land(0);
        handle.scrollToIndex.mockClear();
        sized();
        frame(16);
        expect(handle.scrollToIndex).not.toHaveBeenCalled();
    });

    it("runs the jump to the end instead of cutting to it", async () => {
        motion(false);
        const view = show();
        land(0);
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
        land(0); // the reader left, so the pill stands

        await act(async () => pill(view.container)?.click());
        expect(pill(view.container)).toBeNull();

        frame(100); // the run is under way
        land(300); // and the list hears its own scroll part way there

        expect(pill(view.container)).toBeNull();
    });

    it("jumps at once where the reader asked for less motion", async () => {
        motion(true);
        const view = show();
        land(0);
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
        land(0);
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
        land(0);

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
