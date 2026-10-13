/**
 * The app's motion, as the reader's system asks for it.
 *
 * `MotionGlobalConfig.skipAnimations` is what the tests read (`src/test/setup.ts`), and this is
 * what a person reads: a reader who asked for less motion keeps the page and loses its
 * movement - no travel, no scale, no turn, a tenth of a second of fade, and the endless things
 * standing still. The durations themselves live in `lib/motion.ts`.
 */

import { useMemo } from "react";
import { useReducedMotion } from "motion/react";
import { fade, frame, reveal, shell, slot, stage, swap, turn, type MotionProps } from "@/lib/motion";

export interface Motion {
    /** Whether the reader asked for less motion. */
    still: boolean;
    shell: MotionProps;
    stage: MotionProps;
    slot: MotionProps;
    swap: MotionProps;
    reveal: MotionProps;
    turn: MotionProps;
    /** A part that changes its state where it stands. */
    fade: (opacity: number) => MotionProps;
    /** The list's column, at the width it holds when it is out. */
    frame: (width: number) => MotionProps;
}

export function useMotion(): Motion {
    const still = useReducedMotion() ?? false;
    return useMemo(
        () => ({
            still,
            shell: shell(still),
            stage: stage(still),
            slot: slot(still),
            swap: swap(still),
            reveal: reveal(still),
            turn: turn(still),
            fade: (opacity: number) => fade(still, opacity),
            frame: (width: number) => frame(still, width),
        }),
        [still],
    );
}
