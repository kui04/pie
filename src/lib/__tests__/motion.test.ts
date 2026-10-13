/**
 * The app's motion, as one file states it: one pace and one curve per kind of change, and a
 * reader who asked for less motion keeps the page and loses its movement.
 */

import { describe, expect, it } from "vitest";
import { EASE, MOTION, frame, reveal, shell, slot, spin, stage, swap, turn } from "@/lib/motion";

describe("the app's motion", () => {
    it("moves a page, a slot, a swap and a reveal at their own pace", () => {
        const moved = (bundle: { animate?: unknown }): { duration?: number; ease?: unknown } =>
            (bundle.animate as { transition?: { duration?: number; ease?: unknown } }).transition ?? {};

        // An arrival is confident, a leaving gathers speed, and a small part settles: three
        // curves, one job each.
        expect(moved(stage(false))).toMatchObject({ duration: MOTION.stage.in, ease: EASE.arrive });
        expect((stage(false).exit as { transition: unknown }).transition).toMatchObject({
            duration: MOTION.stage.out,
            ease: EASE.leave,
        });
        // A page is replaced, not moved: it fades through, and only a small part travels.
        expect(stage(false).initial).toEqual({ opacity: 0 });
        expect(stage(false).initial).not.toHaveProperty("y");
        expect(moved({ animate: slot(false).exit })).toMatchObject({ duration: MOTION.slot.out, ease: EASE.leave });
        expect(moved(shell(false))).toMatchObject({ ease: EASE.settle });
        expect(frame(false, 256).animate).toMatchObject({ transition: expect.objectContaining({ ease: EASE.settle }) });
        expect(swap(false).initial).toEqual({ opacity: 0, scale: 0.9 });
        expect(reveal(false).animate).toMatchObject({ height: "auto" });
        expect(moved(shell(false))).toMatchObject({ duration: MOTION.shell });
        expect(shell(false).animate).not.toHaveProperty("y");
        expect(frame(false, 256).animate).toMatchObject({ width: 256 });
    });

    it("keeps the page and drops its movement when the reader asked for less", () => {
        // No travel, no scale, no turn; every fade cut to `MOTION.reduce`, because a thing that
        // appears must still be seen to appear.
        const pace = (bundle: { animate?: unknown; exit?: unknown }): number | undefined =>
            (bundle.animate as { transition?: { duration?: number } }).transition?.duration;

        expect(stage(true)).toMatchObject({ initial: { opacity: 0 } });
        expect(pace(stage(true))).toBe(MOTION.reduce);
        expect((stage(true).exit as { transition: { duration: number } }).transition.duration).toBe(MOTION.reduce);
        expect(slot(true).initial).toEqual({ opacity: 0, y: 0 });
        expect(swap(true).initial).toEqual({ opacity: 0, scale: 1 });
        expect(swap(true).exit).toMatchObject({ scale: 1 });
        expect(pace(reveal(true))).toBe(MOTION.reduce);
        expect(pace(frame(true, 256))).toBe(MOTION.reduce);
        expect(pace(shell(true))).toBe(MOTION.reduce);
        // One endless thing still turns, at half its speed: a ring standing still says a run has
        // stopped. A key that turns to say it worked is movement, and waits for the press.
        expect(turn(true)).toMatchObject({
            animate: { rotate: 360, transition: { duration: MOTION.turnSlow, repeat: Infinity } },
        });
        expect(turn(false)).toMatchObject({
            animate: { rotate: 360, transition: { duration: MOTION.turn, repeat: Infinity } },
        });
        expect(spin(true)).toEqual({});
        expect(pace({ animate: spin(false).animate })).toBe(MOTION.turn);
    });

    it("keeps the endless things in step with the CSS that draws them", () => {
        // Tailwind's `animate-spin` is one second, its own `transition` is 150ms, `duration-50`
        // is 50ms, and `index.css` declares the shimmer at two seconds: one file answers how
        // fast each of them is.
        expect(MOTION.turn).toBe(1);
        expect(MOTION.flip).toBe(0.15);
        expect(MOTION.feedback).toBe(0.05);
        expect(MOTION.shimmer).toBe(2000);
        expect(MOTION.sand).toBeGreaterThan(MOTION.turn);
    });
});
