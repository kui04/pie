/**
 * The app's motion, in one place: 150ms is a swap, 450ms is a surface being
 * replaced. `type: "tween"` is written out because Motion springs transforms by
 * default, and a handover that sprang would overshoot the screen it is leaving.
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

/**
 * One stage of a window giving way to the next: the landing to a load, a load to
 * the words. A short tween, no travel through a page that did not move.
 */
export const STAGE = { type: "tween", duration: 0.22, ease: [0.2, 0, 0, 1] } as const;

/** How a stage that is leaving stands: quiet, in its own place. */
export const STAGE_LEAVE = { opacity: 0 } as const;

/** How the stage that takes its place arrives: faintly low, then in place. */
export const STAGE_ARRIVE = { opacity: 0, y: 8 } as const;

/** Where that stage stands once it is in place. */
export const STAGE_SETTLED = { opacity: 1, y: 0 } as const;

/** A card's body opening: a short tween of its own height, and no overshoot. */
export const REVEAL = { type: "tween", duration: 0.2, ease: [0.2, 0, 0, 1] } as const;

/**
 * The session list taking a column of its own: a short tween of its width.
 *
 * The transcript gives the room up as the column takes it, so the width is what
 * moves: a column of the window opening, not a surface arriving over one.
 */
export const UNFOLD = { type: "tween", duration: 0.28, ease: [0.2, 0, 0, 1] } as const;

/** How that column stands while the window is too narrow for it, or folded away. */
export const UNFOLD_HIDDEN = { width: 0 } as const;

/**
 * How it stands while there is room: `w-64` (256px), the column's own width. The
 * column inside keeps that width as the box opens, so what moves is the edge and
 * the hairline on it, not the rows.
 */
export const UNFOLD_SHOWN = { width: 256 } as const;

/** How a body stands while it is closed. */
export const REVEAL_HIDDEN = { height: 0, opacity: 0 } as const;

/** How it stands while it is open: its own height, whatever that turned out to be. */
export const REVEAL_SHOWN = { height: "auto", opacity: 1 } as const;

/**
 * The hourglass: one cycle, and the moments in it - the transfer is over, the turn
 * is over. One clock, not two: two made the seam flicker.
 */
export const HOURGLASS_CYCLE = 3000;

/** Nothing, the transfer finished, the turn finished, and the end - the beginning. */
export const HOURGLASS_STEPS = [0, 0.5, 0.72, 1] as const;

/** The ring of a call that is running now: a full turn, repeating without a seam. */
export const SPIN = { type: "tween", duration: 1, ease: "linear", repeat: Infinity } as const;

/** The turn of that ring. */
export const SPIN_TURN = { rotate: 360 } as const;

/**
 * The turn of the refresh key: one turn, from where the icon stood back to it.
 *
 * One turn and not a loop, because the key says what a hand did and not what the
 * host is doing: a read of the list of a local host is over before a loop would
 * show, and the key was pressed. The turn is the same length every time.
 */
export const REFRESH_TURN = { type: "tween", duration: 0.6, ease: "easeInOut" } as const;

/**
 * The light of a session row: one breath in milliseconds - dim, bright, dim.
 *
 * A cycle rather than a Motion transition, because the component writes this one on
 * Motion's frame clock. A transition of `opacity` is driven by `Element.animate`,
 * and an animation that a row is taken away in the middle of is `cancel()`ed: the
 * spec rejects that animation's `finished` promise and nothing holds it.
 */
export const BREATHE_CYCLE = 2400;
