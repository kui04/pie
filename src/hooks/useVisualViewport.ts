/**
 * The visual viewport: the part of the layout viewport the reader can see.
 *
 * A keyboard can shrink it and pan it without changing the layout viewport.
 * The offset is where its top-left corner starts inside the layout viewport;
 * width, height and scale describe the visible rectangle itself.
 *
 * keyboardInset is the extra CSS px that has to be reserved at the bottom to
 * keep content above the on-screen keyboard. On platforms that shrink the
 * layout viewport itself (Android Chrome) this is 0 by design: the layout is
 * already above the keyboard, so nothing extra has to be added.
 */

import { useSyncExternalStore } from "react";

export interface VisualViewportState {
    offsetLeft: number;
    offsetTop: number;
    height: number;
    width: number;
    scale: number;
    /** Extra px to reserve at the bottom to clear the on-screen keyboard. */
    keyboardInset: number;
}

const NO_VIEWPORT: VisualViewportState = {
    offsetLeft: 0,
    offsetTop: 0,
    height: 0,
    width: 0,
    scale: 1,
    keyboardInset: 0,
};

/** Smaller insets are treated as toolbar animation / rounding noise, not a keyboard. */
const KEYBOARD_THRESHOLD = 80;

function computeKeyboardInset(offsetTop: number, height: number, scale: number): number {
    // Pinch zoom shrinks the visible height without a keyboard; do not mistake it for one.
    if (scale !== 1) return 0;
    const innerHeight = window.innerHeight;
    const inset = innerHeight - (offsetTop + height);
    if (!Number.isFinite(inset) || inset < KEYBOARD_THRESHOLD) return 0;
    return Math.round(inset);
}

let measured: VisualViewportState = NO_VIEWPORT;
let measuredKey = "";

function visualViewport(): VisualViewportState {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) {
        const height = window.innerHeight;
        const width = window.innerWidth;
        // No visual viewport: the layout viewport is the visible rect and the
        // keyboard (if any) has already shrunk it, so no extra inset is needed.
        const key = `0:0:${width}:${height}:1:0`;
        if (key !== measuredKey) {
            measuredKey = key;
            measured = {
                offsetLeft: 0,
                offsetTop: 0,
                height,
                width,
                scale: 1,
                keyboardInset: 0,
            };
        }
        return measured;
    }

    // Round pixel values: iOS Safari reports sub-pixel geometry that makes
    // layout jitter for no visual benefit.
    const left = Math.round(viewport.offsetLeft ?? 0);
    const top = Math.round(viewport.offsetTop ?? 0);
    const height = Math.round(viewport.height);
    const width = Math.round(viewport.width);
    const scale = viewport.scale ?? 1;
    const keyboardInset = computeKeyboardInset(top, height, scale);
    const key = `${left}:${top}:${width}:${height}:${scale}:${keyboardInset}`;
    if (key !== measuredKey) {
        measuredKey = key;
        measured = { offsetLeft: left, offsetTop: top, height, width, scale, keyboardInset };
    }
    return measured;
}

/** Shared with the keyboard hook, which also has to notice a visual viewport change. */
export function subscribeToVisualViewport(notify: () => void): () => void {
    const viewport = window.visualViewport;
    // A keyboard animates in over many frames; one notice per frame is enough.
    let frame = 0;
    const changed = () => {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(() => {
            frame = 0;
            notify();
        });
    };
    if (viewport === null || viewport === undefined) {
        window.addEventListener("resize", changed);
        return () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener("resize", changed);
        };
    }
    viewport.addEventListener("resize", changed);
    viewport.addEventListener("scroll", changed);
    window.addEventListener("resize", changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
        window.cancelAnimationFrame(frame);
        viewport.removeEventListener("resize", changed);
        viewport.removeEventListener("scroll", changed);
        window.removeEventListener("resize", changed);
        document.removeEventListener("visibilitychange", changed);
    };
}

/**
 * Subscribes to the visual viewport and returns its current geometry.
 *
 * The snapshot is a cached, referentially stable object: it is only replaced
 * when one of the rounded geometry values (offsetLeft, offsetTop, width,
 * height, scale) or the derived keyboardInset actually changes. Values are
 * rounded to whole pixels to avoid sub-pixel layout jitter reported by iOS
 * Safari.
 *
 * Use this when you need the full geometry — e.g. positioning something
 * against the visible rectangle, or driving layout off offsetTop / height.
 * Prefer plain CSS variables written directly from
 * `subscribeToVisualViewport` for pure visual tracking: that bypasses React
 * rendering entirely and stays in sync with the compositor.
 *
 * If you only care whether the on-screen keyboard is up (or how much room it
 * takes), use `useKeyboardInset` instead. It exposes a primitive snapshot, so
 * components do not re-render on every frame of the keyboard animation.
 *
 * Notes:
 * - During the keyboard animation this returns a new snapshot per frame; keep
 *   the consumer cheap, or fold the value into a boolean/enum before use.
 * - `keyboardInset` is 0 on platforms that shrink the layout viewport itself
 *   (Android Chrome): the content is already above the keyboard, so nothing
 *   extra has to be reserved.
 * - When `window.visualViewport` is unavailable (e.g. some older WebViews),
 *   it falls back to `window.innerWidth` / `innerHeight` with offset 0 and
 *   scale 1.
 * - The server snapshot is a constant zeroed viewport, so SSR and the first
 *   client render agree; the real value arrives after hydration.
 *
 * @returns The current {@link VisualViewportState}, including `keyboardInset`.
 */
export function useVisualViewport(): VisualViewportState {
    return useSyncExternalStore(subscribeToVisualViewport, visualViewport, () => NO_VIEWPORT);
}

function keyboardInsetSnapshot(): number {
    return visualViewport().keyboardInset;
}

/**
 * Only the keyboard inset, as a primitive snapshot. Kept separate from
 * useVisualViewport so consumers that only care about the keyboard do not
 * re-render on every offsetTop / height change during the keyboard animation:
 * a number snapshot is compared by value, so the store looks stable until the
 * inset itself crosses the threshold.
 */
export function useKeyboardInset(): number {
    return useSyncExternalStore(subscribeToVisualViewport, keyboardInsetSnapshot, () => 0);
}
