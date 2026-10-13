/**
 * How the app moves, in one place: a component names a token here, never a duration of its own.
 *
 * Every builder takes `still`: a reader who asked for less motion keeps the page and loses its
 * movement - no travel, no scale, no turn, and every fade cut to `MOTION.reduce`.
 *
 * Not here: the transcript's own glide (`SessionTranscript`, a distance over time rather than a
 * transition), the class-based motions - Tailwind's `transition`, `animate-spin`, the shimmer of
 * `index.css` - whose numbers are the `MOTION` entries below, and what Radix, Vaul and sonner
 * move in their own files.
 */

import type { MotionProps, Transition } from "motion/react";

export type { MotionProps };

/** Durations, in seconds; the endless ones in milliseconds where a frame clock reads them. */
export const MOTION = {
    /** The shell of the app arriving. */
    shell: 0.15,
    /** A page replacing a page, one half each: the pair is a view change, and each is short. */
    stage: { in: 0.24, out: 0.16 },
    /** A small part arriving or leaving beside where it stands. */
    slot: { in: 0.15, out: 0.12 },
    /** A small part replaced in the box it holds. */
    swap: { in: 0.15, out: 0.12 },
    /** A body opening or closing. */
    reveal: { in: 0.2, out: 0.16 },
    /** The list's column, taken out of the window or given back to it. */
    frame: 0.3,
    /** One cycle of the ring of a run at work, and of a spinner. */
    turn: 1,
    /** The same ring for a reader who asked for less motion: the same fact, told slowly. */
    turnSlow: 2,
    /** One cycle of the hourglass' sand. */
    sand: 3,
    /** One breath of the light of a row, in milliseconds. */
    breath: 2400,
    /** One pass of the shimmer over a thought, in milliseconds. */
    shimmer: 2000,
    /** A chevron turning over: Tailwind's own `transition`. */
    flip: 0.15,
    /** A colour under the pointer: `duration-50`. */
    feedback: 0.05,
    /** What a reader who asked for less motion gets in place of a move: a short fade. */
    reduce: 0.1,
} as const;

/** The curves. One per job a curve has, not one for the whole app. */
export const EASE = {
    /** An arrival: off the mark at once, then settling onto its place. */
    arrive: [0.16, 1, 0.3, 1],
    /** A small part appearing or changing where it belongs: gentle at both ends. */
    settle: [0.2, 0, 0, 1],
    /** A leaving: it gathers speed and is gone. A leaving is not an arrival backwards. */
    leave: [0.4, 0, 1, 1],
    /** The endless things. */
    loop: "linear",
} as const;

/**
 * How far a small part travels while it fades. A page does not travel: it is replaced, and the
 * thing it is replaced by is its peer.
 */
export const RISE = 4;

/** How far a part that is replaced in its own box shrinks and grows. */
export const SCALE = { in: 0.9, out: 1.1 } as const;

/** One move at a stated pace, or - for a reader who asked for less motion - one short fade. */
function tween(duration: number, still: boolean, ease: Transition["ease"]): Transition {
    return { type: "tween", duration: still ? MOTION.reduce : duration, ease };
}

/** The shell of the app: the window fades in, and nothing travels. */
export function shell(still: boolean): MotionProps {
    return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: tween(MOTION.shell, still, EASE.settle) },
    };
}

/** A page, or a conversation, replacing another under the bar. It fades through. */
export function stage(still: boolean): MotionProps {
    return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: tween(MOTION.stage.in, still, EASE.arrive) },
        exit: { opacity: 0, transition: tween(MOTION.stage.out, still, EASE.leave) },
    };
}

/** A part of the page appearing or leaving just outside where it stands. */
export function slot(still: boolean): MotionProps {
    const travel = still ? 0 : RISE;
    return {
        initial: { opacity: 0, y: travel },
        animate: { opacity: 1, y: 0, transition: tween(MOTION.slot.in, still, EASE.settle) },
        exit: { opacity: 0, transition: tween(MOTION.slot.out, still, EASE.leave) },
    };
}

/** A part replaced in the box it already holds, so it shrinks in and grows out. */
export function swap(still: boolean): MotionProps {
    return {
        initial: { opacity: 0, scale: still ? 1 : SCALE.in },
        animate: { opacity: 1, scale: 1, transition: tween(MOTION.swap.in, still, EASE.settle) },
        exit: { opacity: 0, scale: still ? 1 : SCALE.out, transition: tween(MOTION.swap.out, still, EASE.leave) },
    };
}

/** A part of the page whose own height moves while it opens or closes. */
export function reveal(still: boolean): MotionProps {
    return {
        initial: { height: 0, opacity: 0 },
        animate: { height: "auto", opacity: 1, transition: tween(MOTION.reveal.in, still, EASE.settle) },
        exit: { height: 0, opacity: 0, transition: tween(MOTION.reveal.out, still, EASE.leave) },
    };
}

/** A part that changes its state where it stands: a form dimmed while a connect runs. */
export function fade(still: boolean, opacity: number): MotionProps {
    return { animate: { opacity, transition: tween(MOTION.slot.in, still, EASE.settle) } };
}

/** The column of the list, taken out of the window or given back to it. */
export function frame(still: boolean, width: number): MotionProps {
    return {
        initial: { width: 0 },
        animate: { width, transition: tween(MOTION.frame, still, EASE.settle) },
        exit: { width: 0, transition: tween(MOTION.frame, still, EASE.leave) },
    };
}

/**
 * Something endless: the ring of a run at work, and the spinner of a page on its way.
 *
 * A reader who asked for less motion keeps it, twice as slow. The turn is not decoration: it is
 * what says that a run is still going on, and a ring standing still says the opposite.
 */
export function turn(still: boolean): MotionProps {
    return {
        animate: {
            rotate: 360,
            transition: {
                type: "tween",
                duration: still ? MOTION.turnSlow : MOTION.turn,
                ease: EASE.loop,
                repeat: Infinity,
            },
        },
    };
}

/** One turn of a key that says it worked, and then still. */
export function spin(still: boolean): MotionProps {
    if (still) return {};
    return {
        initial: { rotate: 0 },
        animate: { rotate: 360, transition: tween(MOTION.turn, still, EASE.loop) },
    };
}
