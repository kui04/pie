import { useEffect, useRef } from "react";
import { animate } from "motion/react";
import { useMotion } from "@/hooks/use-motion";
import { EASE, MOTION } from "@/lib/motion";

/**
 * One clock for every hourglass on screen: one Motion animation drives the cycle
 * and each card reads it. A loop per card is a frame callback per card.
 */
const listeners = new Set<(progress: number) => void>();
let stop: (() => void) | null = null;

function subscribe(listener: (progress: number) => void): () => void {
    if (listeners.size === 0) {
        const cycle = animate(0, 1, {
            duration: MOTION.sand,
            ease: EASE.loop,
            repeat: Infinity,
            onUpdate: (progress) => {
                for (const each of listeners) each(progress);
            },
        });
        stop = () => cycle.stop();
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            stop?.();
            stop = null;
        }
    };
}

/** The glass: two triangles that meet at the neck. */
const TOP = 2;
const NECK = 12;
const FLOOR = 22;
const LEFT = 5;
const RIGHT = 19;
/** A bulb's half-width over its height: 7 across 10. */
const SLOPE = 0.7;
const [DRAIN_END, TURN_END] = [0.5, 0.72];

/**
 * The sand above, at `full` 1 through 0: the surface is horizontal and its ends
 * are the glass's own edges, so the sand can never leave the glass.
 */
function sandAbove(full: number): string {
    const y = TOP + (1 - full) * (NECK - TOP);
    const x = LEFT + (y - TOP) * SLOPE;
    return `M${x} ${y}H${2 * NECK - x}L${NECK} ${NECK}Z`;
}

/** The pile below, at `full` 1 (to the neck) through 0, grown from the floor. */
function sandBelow(full: number): string {
    const y = FLOOR - full * (FLOOR - NECK);
    const x = NECK - (y - NECK) * SLOPE;
    return `M${x} ${y}H${2 * NECK - x}L${RIGHT} ${FLOOR}H${LEFT}Z`;
}

/** The turn of the cycle: still, then over, then still. */
function turnAt(progress: number): number {
    if (progress <= DRAIN_END) return 0;
    if (progress >= TURN_END) return 180;
    const x = (progress - DRAIN_END) / (TURN_END - DRAIN_END);
    return (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2) * 180;
}

/**
 * The sand and the turn are written from the one clock above, and the turn is on
 * the inner group: a transform on the root `svg` is a CSS transform, in pixels of
 * the element rather than units of the viewBox.
 */
export function Hourglass({ label }: { label: string }) {
    const { still } = useMotion();
    const glass = useRef<SVGGElement>(null);
    const above = useRef<SVGPathElement>(null);
    const below = useRef<SVGPathElement>(null);

    useEffect(() => {
        if (still) return;
        return subscribe((progress) => {
            const level = Math.min(1, progress / DRAIN_END);
            above.current?.setAttribute("d", sandAbove(1 - level));
            below.current?.setAttribute("d", sandBelow(level));
            glass.current?.setAttribute("transform", `rotate(${turnAt(progress)} ${NECK} ${NECK})`);
        });
    }, [still]);

    return (
        <svg
            viewBox="0 0 24 24"
            role="img"
            aria-label={label}
            className="text-foreground size-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
        >
            <g ref={glass}>
                <path ref={above} d={sandAbove(1)} fill="currentColor" stroke="none" className="text-warning" />
                <path ref={below} d={sandBelow(0)} fill="currentColor" stroke="none" className="text-warning" />
                <path d={`M${LEFT} ${TOP}H${RIGHT}L${NECK} ${NECK}Z`} />
                <path d={`M${LEFT} ${FLOOR}H${RIGHT}L${NECK} ${NECK}Z`} />
            </g>
        </svg>
    );
}
