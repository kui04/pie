/**
 * The one way the app asks the system whether the reader wants less motion.
 *
 * What the system answers here is jsdom's own business (it answers `reduce`, and the tests
 * skip animations besides: `src/test/setup.ts`); what these tests hold is that one answer
 * decides every move, and that `lib/motion.ts` builds each of them for a reader who asked
 * for less, `lib/__tests__/motion.test.ts` holds the other way round.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMotion } from "@/hooks/use-motion";
import { MOTION, frame, reveal, slot, stage, turn } from "@/lib/motion";

describe("useMotion", () => {
    it("builds every move of the app from the one answer the system gave", () => {
        const { result } = renderHook(() => useMotion());

        expect(typeof result.current.still).toBe("boolean");
        expect(result.current.stage).toEqual(stage(result.current.still));
        expect(result.current.slot).toEqual(slot(result.current.still));
        expect(result.current.reveal).toEqual(reveal(result.current.still));
        expect(result.current.turn).toEqual(turn(result.current.still));
        expect(result.current.frame(256)).toEqual(frame(result.current.still, 256));
    });

    it("keeps the page and drops its movement when the reader asked for less", () => {
        // jsdom answers the query as "reduce" for every query it is asked (it has no media
        // queries), so this is also the answer the rest of the suite runs with.
        const { result } = renderHook(() => useMotion());
        if (!result.current.still) return;

        expect(result.current.turn).toEqual({});
        expect(result.current.stage.initial).toEqual({ opacity: 0 });
        const animate = result.current.stage.animate as { transition: { duration: number } };
        expect(animate.transition.duration).toBe(MOTION.reduce);
    });
});
