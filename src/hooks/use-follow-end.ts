/**
 * Following the end of a list that grows while the reader reads it.
 *
 * The rule is a lock and not a position: the reader takes the list with their own hand - a
 * wheel back up it, a finger pushing the words back, a step of the bar - and gives it back by
 * coming down onto its end again, or by asking for it (`toEnd`). While they hold it, the run
 * writes on without dragging them anywhere.
 *
 * The list is virtua's, so the hook hands back the refs it works through: `list` for the
 * handle - the jump, and the sizes the library learns - and `viewport` for the element that
 * scrolls, which the glide writes. `rows` is the drawn list itself: a change to it is a
 * reason to follow the end again, which is why its identity is read and not only its length.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
    type TouchEvent,
    type WheelEvent,
} from "react";
import type { VirtualizerHandle } from "virtua";

/** How close to the end counts as standing at it, in pixels. */
const NEAR = 24;

/**
 * The pill's jump runs, in pixels a millisecond. A jump over a long transcript is not
 * proportionally slower - the rows on the way have to be drawn for the measurement to
 * follow the scroll - so the speed is fixed and only the length of the run grows with
 * the distance, between these two bounds.
 */
const GLIDE_SPEED = 4;
const GLIDE_MIN_MS = 160;
const GLIDE_MAX_MS = 640;

/**
 * Whether the engine's reader asked for less motion. Asked here and not through motion's
 * hook because the answer is wanted once, where the pill is pressed, and not as a value
 * that re-renders the list.
 */
const wantsLessMotion = () =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface FollowEnd {
    /** The virtualizer's own handle, which the jump to the end goes through. */
    list: RefObject<VirtualizerHandle | null>;
    /** The element that scrolls: virtua only draws the rows, and the glide writes here. */
    viewport: RefObject<HTMLDivElement | null>;
    /** Whether the reader holds the list: the pill that asks for the end stands. */
    away: boolean;
    /** Send the list to its end, gliding over the rows on the way. */
    toEnd: () => void;
    /** What virtua reports: where it stands, and when the sizes it knows have moved. */
    onScroll: (offset: number) => void;
    onResize: () => void;
    onScrollEnd: () => void;
    /** What the region around the scroller reports: the reader's own hand. */
    onWheel: (event: WheelEvent<HTMLDivElement>) => void;
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => void;
}

/** A hook onto the end of a list of `rows`, which the caller draws as virtua's list. */
export function useFollowEnd(rows: readonly unknown[]): FollowEnd {
    const list = useRef<VirtualizerHandle>(null);
    const viewport = useRef<HTMLDivElement>(null);
    /** The reader has the list: the run writes on without them, and the pill stands. */
    const escaped = useRef(false);
    const [away, setAway] = useState(false);
    /** Where the list was last seen, how tall it was, and the finger moving it. */
    const last = useRef(0);
    const measured = useRef(0);
    const finger = useRef(0);
    /** A size the list just learned: the offset it moves by is the list's own, not a scroll. */
    const shifted = useRef(false);
    /** The reader is wheeling down the list: whatever that lands at the end is theirs to have. */
    const heading = useRef(false);
    const gliding = useRef(false);
    const glide = useRef<number | undefined>(undefined);
    /** A pin of ours is on its way to the end of this task, and is not to be queued twice. */
    const pinning = useRef(false);
    const count = rows.length;

    /** Whether a position stands at the end of the list, within a row's reach of it. */
    const atEnd = (handle: VirtualizerHandle, offset: number) =>
        handle.scrollSize - handle.viewportSize - offset <= NEAR;

    /**
     * Send the list to its end, and remember that the end it lands on is only ever as
     * right as the sizes virtua knows. Virtua measures a row when it draws it, so the
     * height of a row drawn for the first time - or of one whose words rewrapped -
     * reaches its arithmetic only after that measurement.
     */
    const seekEnd = useCallback(() => {
        if (count > 0) list.current?.scrollToIndex(count - 1, { align: "end" });
    }, [count]);

    const stopGlide = useCallback(() => {
        if (glide.current !== undefined) cancelAnimationFrame(glide.current);
        glide.current = undefined;
        gliding.current = false;
    }, []);

    useEffect(
        () => () => {
            stopGlide();
        },
        [stopGlide],
    );

    // Follow the end while the reader is there: when the list changes (not only when it
    // grows - a row can be replaced by one that reads differently), and when the sizes of
    // the rows it pads itself by move it. Before the paint, not after: the frame the reader
    // is shown has to be the frame the end is already at, or the foot of the list leaves the
    // window and comes back for every line a run writes.
    useLayoutEffect(() => {
        if (!escaped.current && !gliding.current) seekEnd();
    }, [rows, seekEnd]);

    /** The reader has the list: the run follows no more, and the pill asks them back. */
    const leave = useCallback(() => {
        stopGlide();
        escaped.current = true;
        heading.current = false;
        setAway(true);
    }, [stopGlide]);

    /** Hand the end back to the run: the reader is on it again. */
    const follow = () => {
        escaped.current = false;
        heading.current = false;
        setAway(false);
    };

    const onScroll = (offset: number) => {
        const handle = list.current;
        if (!handle) return;
        const previous = last.current;
        last.current = offset;
        // A jump of ours is carrying the list: where it stands on the way is not where the
        // reader is. A hand on it ends that run before this point (`onWheel`, `onTouchMove`).
        if (gliding.current) return;
        // A step back up the list is the reader's own hand, and the run follows no more; coming
        // down onto the end again hands the list back. Neither reading is taken from a scroll
        // that a size the list just learned is what moved: virtua keeps the view still when a row
        // above the window is measured, and that is nobody's scrolling. A wheel says the same
        // thing in its own words, which is why it is read as well.
        const moved = shifted.current;
        shifted.current = false;
        if (offset < previous && !moved) leave();
        else if (offset > previous && atEnd(handle, offset) && (!moved || heading.current)) follow();
    };

    const onScrollEnd = () => {
        // A glide can be stopped short by a row that grows while it runs, and the reader who
        // asked for the end still has to get there.
        if (!escaped.current) seekEnd();
    };

    const onResize = () => {
        const handle = list.current;
        shifted.current = true;
        if (handle !== null) {
            // A row that measured shorter than its estimate moved the end back up: a reader
            // already at it has the list again.
            if (escaped.current && handle.scrollSize < measured.current) {
                if (atEnd(handle, viewport.current?.scrollTop ?? 0)) follow();
            }
            // The content came back shorter than it was - a row measured smaller, or a whole list
            // rebuilt. What the scroller does then (it clamps, and can land at the top) is the
            // list's own doing, and no reading of the reader is taken from it.
            if (handle.scrollSize < measured.current) shifted.current = true;
            measured.current = handle.scrollSize;
        }
        if (escaped.current || gliding.current || pinning.current) return;
        // Every height virtua learns moves the end, so a jump of ours is taken again until the
        // sizes settle. This is what the library's own correction cannot be trusted to finish:
        // it stops after a quiet spell and the browser may drop the notifications it was
        // waiting for. The pin runs in a microtask rather than in the observer's own delivery -
        // what virtua does with its own correction - so the frame the reader is shown is the
        // frame the end is already at, and no scroll is written from inside a delivery.
        pinning.current = true;
        queueMicrotask(() => {
            pinning.current = false;
            if (!escaped.current && !gliding.current) seekEnd();
        });
    };

    const toEnd = () => {
        const handle = list.current;
        follow();
        if (!handle || count === 0) return;
        const scroller = viewport.current;
        const from = scroller?.scrollTop ?? 0;
        const target = handle.scrollSize - handle.viewportSize;
        const distance = target - from;
        // A jump that is already there, a reader who asked for less motion, or a scroller
        // this code cannot reach: the library's own jump, at once.
        if (!scroller || wantsLessMotion() || distance <= NEAR) {
            seekEnd();
            return;
        }
        // A glide and not a cut, because of the rows on the way: virtua measures a row only
        // when it draws it, so a jump over the rows in between lands on their estimated
        // heights and leaves the tail wherever those estimates put it - the reading the
        // reader fixes by dragging the bar through the list once. Running the scroll through
        // them draws every one of them, and the end it arrives at is the end it measured. How
        // long the run takes is its length over the speed, easing out onto the end.
        stopGlide();
        gliding.current = true;
        const duration = Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, distance / GLIDE_SPEED));
        let started: number | undefined;
        const step = (now: number) => {
            started ??= now;
            const t = Math.min(1, (now - started) / duration);
            const rest = 1 - t;
            const end = list.current ? list.current.scrollSize - list.current.viewportSize : target;
            scroller.scrollTop = from + (end - from) * (1 - rest * rest * rest);
            if (t < 1) {
                glide.current = requestAnimationFrame(step);
                return;
            }
            glide.current = undefined;
            gliding.current = false;
            seekEnd();
        };
        glide.current = requestAnimationFrame(step);
    };

    // A wheel and a finger are the reader's own hand: they end a jump of ours, and going back
    // up the list gives the end up here rather than at the scroll event that follows, which the
    // next frame of the pin could still beat. A wheel the other way, onto the end, is the same
    // hand asking for it back.
    const onWheel = (event: WheelEvent<HTMLDivElement>) => {
        stopGlide();
        if (event.deltaY < 0) leave();
        else if (event.deltaY > 0) heading.current = true;
    };

    const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
        finger.current = event.touches[0]?.clientY ?? 0;
        stopGlide();
    };

    const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
        const at = event.touches[0]?.clientY ?? 0;
        const moved = at - finger.current;
        finger.current = at;
        // A finger moving down the screen pushes the words back: the same leaving.
        if (moved > 0) leave();
    };

    return {
        list,
        viewport,
        away,
        toEnd,
        onScroll,
        onResize,
        onScrollEnd,
        onWheel,
        onTouchStart,
        onTouchMove,
    };
}
