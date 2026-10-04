/**
 * The app's motion, in one place.
 *
 * Anything that moves should take its shape from here, so a screen reads as one
 * thing rather than as whichever library each part happened to use. The values
 * are the design's own scale: 150ms is a swap, 450ms is a surface being
 * replaced.
 *
 * `type: "tween"` is written out rather than left to the default because Motion
 * springs transform values by default and tweens everything else. A page handover
 * that sprang would overshoot the screen it is leaving; the curve here is the
 * one the durations were chosen against.
 */

/** Something appearing or disappearing in place. */
export const SWAP = { type: "tween", duration: 0.15 } as const;

/** The window arriving, and one surface giving way to another. */
export const HANDOVER = { type: "tween", duration: 0.45, ease: [0.2, 0, 0, 1] } as const;

/** How a surface arrives: from nothing, a little to one side. */
export const ARRIVE = { opacity: 0, x: 24 } as const;

/** How a surface leaves: to nothing, past the other way. */
export const LEAVE = { opacity: 0, x: -24 } as const;

/** An element that took a slot, settling into place. */
export const SETTLED = { opacity: 1, x: 0 } as const;

/** An icon swapped for another one: in slightly small, out at full size. */
export const SWAPPED_IN = { opacity: 0, scale: 0.9 } as const;

/** The element an icon swap replaced. */
export const SWAPPED_OUT = { opacity: 0, scale: 1.1 } as const;
