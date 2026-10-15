import { useEffect, useRef, type RefObject } from "react";
import { MOTION } from "@/lib/motion";

/** How close to the end counts as the end: a wheel or a finger never lands exactly on it. */
const NEAR = 24;

/** The keys a reader uses to walk back through a body. */
const BACK = new Set(["ArrowUp", "PageUp", "Home"]);

/** How tall the shaded edge of a window is, in the same pixels the mask is written in. */
const EDGE = 16;

/** How close to the end a chase snaps onto it: a fifth of a line, so the newest line is never
 * left clipped by an approach that never quite arrives. */
const SNAP = 4;

/**
 * The window of a live body: a box that keeps its newest line in view while it grows, and says
 * which of its edges have more behind them.
 *
 * It chases the end rather than jumping to it. Every frame moves a share of what is left, so a
 * line that lands while the one before it is still travelling is taken up by the same motion -
 * a jump per line, or a jump per token, is the thing this exists to avoid.
 *
 * Following is a lock, not a position. Content that arrives moves the window itself, so a rule
 * that read the position would let the run steal its own lock and follow nothing; only the
 * reader's own hand takes the window back, and reaching the end again gives it up.
 *
 * The same frame publishes which edges are shaded (`data-fade`, read as a mask by
 * `index.css`), so an edge only fades where there is something behind it.
 *
 * A reader who asked for less motion gets the end itself, without the chase.
 */
export function useFollowTail(active: boolean, still: boolean): RefObject<HTMLDivElement | null> {
    const box = useRef<HTMLDivElement>(null);
    const following = useRef(true);

    useEffect(() => {
        const element = box.current;
        if (element === null) return;
        following.current = true;

        const atEnd = () => element.scrollHeight - element.clientHeight - element.scrollTop <= NEAR;
        let touchedAt = element.scrollTop;

        const onWheel = (event: WheelEvent) => {
            if (event.deltaY < 0) following.current = false;
            else if (atEnd()) following.current = true;
        };
        const onTouchStart = () => {
            touchedAt = element.scrollTop;
        };
        const onTouchMove = () => {
            if (element.scrollTop < touchedAt) following.current = false;
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (BACK.has(event.key)) following.current = false;
            else if (event.key === "End") following.current = true;
        };
        // Arriving at the end under their own power takes the lock back; the window's own
        // movement never gives it up.
        const onScroll = () => {
            if (atEnd()) following.current = true;
            else touchedAt = element.scrollTop;
        };

        element.addEventListener("wheel", onWheel, { passive: true });
        element.addEventListener("touchstart", onTouchStart, { passive: true });
        element.addEventListener("touchmove", onTouchMove, { passive: true });
        element.addEventListener("keydown", onKeyDown);
        element.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            element.removeEventListener("wheel", onWheel);
            element.removeEventListener("touchstart", onTouchStart);
            element.removeEventListener("touchmove", onTouchMove);
            element.removeEventListener("keydown", onKeyDown);
            element.removeEventListener("scroll", onScroll);
        };
    }, [active]);

    useEffect(() => {
        const element = box.current;
        if (element === null) return;

        let frame = 0;
        let last = 0;
        const step = (now: number) => {
            const target = element.scrollHeight - element.clientHeight;

            if (active && following.current && target > 0) {
                if (still) {
                    element.scrollTop = target;
                } else {
                    const share = 1 - Math.exp(-(last === 0 ? 16 : now - last) / MOTION.follow);
                    const next = element.scrollTop + (target - element.scrollTop) * share;
                    element.scrollTop = Math.abs(target - next) < SNAP ? target : next;
                }
            }

            const over = element.scrollHeight - element.clientHeight;
            const faded =
                over > EDGE / 2 ? `${element.scrollTop > 1 ? "t" : ""}${element.scrollTop < over - 1 ? "b" : ""}` : "";
            if (element.dataset.fade !== faded) element.dataset.fade = faded;

            // A chase that has arrived stays arrived: writing the end each frame is what keeps a
            // late layout from leaving the newest line half a frame below the fold.
            if (active && following.current && target - element.scrollTop < SNAP && target >= 0)
                element.scrollTop = target;

            last = now;
            frame = requestAnimationFrame(step);
        };

        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, [active, still]);

    return box;
}
