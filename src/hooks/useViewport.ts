/**
 * The measurements of the window that the app reads in JavaScript.
 *
 * The width decides whether the workspace keeps its session column; the visual
 * viewport decides how far the on-screen keyboard reaches into a sheet. They are
 * separate reads: a component that only asks about the width does not subscribe to
 * the keyboard, and one that only asks about the keyboard does not subscribe to
 * the media query.
 */

import { useSyncExternalStore } from "react";

/**
 * Whether the window is wide enough for the workspace's permanent session column.
 *
 * The width is written twice: as the Tailwind class that shows that column, and as
 * this query. Two things about the surfaces are JavaScript's rather than CSS's — a
 * column hidden by `display: none` still reads the sessions of the host, and a sheet
 * that is open holds the page itself (Radix puts `pointer-events: none` on the body)
 * — so a hand-written media query is warranted here.
 */

/** Tailwind's `lg`, as `matchMedia` spells it. */
const WIDE_WINDOW = "(min-width: 64rem)";

function subscribeToWidth(read: () => void): () => void {
    const query = window.matchMedia(WIDE_WINDOW);
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
}

function width(): boolean {
    return window.matchMedia(WIDE_WINDOW).matches;
}

export function useWideWindow(): boolean {
    return useSyncExternalStore(
        subscribeToWidth,
        width,
        // A window is not a thing this app renders outside a browser.
        () => false,
    );
}

/**
 * The visual viewport, as the app reads it for the keyboard and for a fixed
 * drawer's place on screen.
 *
 * `inset` is the room the keyboard takes from the layout viewport: the gap
 * between `window.innerHeight` and the visual viewport. `offsetTop` is where
 * the visual viewport starts inside the layout viewport. They are separate
 * facts: a WebView can shrink the visual viewport without moving it (inset
 * without offset), or pan it while the visual height stays the same.
 *
 * A gap below the threshold is chrome noise, not a keyboard. Pinch zoom also
 * shrinks the visual viewport, so it leaves the keyboard inset at zero.
 */

/** A gap below this is chrome noise (URL bar), not a keyboard. */
const OPEN_THRESHOLD = 100;

export interface VisualViewportState {
    /** How much room the keyboard takes, in CSS pixels. */
    inset: number;
    /** Where the visual viewport starts inside the layout viewport. */
    offsetTop: number;
}

type MeasuredViewport = VisualViewportState & { scale: number | undefined; height: number; innerHeight: number };

let measured: MeasuredViewport | null = null;
const CLOSED: VisualViewportState = { inset: 0, offsetTop: 0 };

function visualViewport(): VisualViewportState {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return CLOSED;

    const height = viewport.height;
    const innerHeight = window.innerHeight;
    const scale = viewport.scale;
    const offsetTop = viewport.offsetTop ?? 0;
    const gap = innerHeight - height;
    const keyboard = scale === undefined || Math.abs(scale - 1) <= 0.01 ? gap : 0;
    const inset = keyboard >= OPEN_THRESHOLD ? keyboard : 0;

    if (
        measured !== null &&
        measured.height === height &&
        measured.innerHeight === innerHeight &&
        measured.scale === scale &&
        measured.offsetTop === offsetTop &&
        measured.inset === inset
    ) {
        return measured;
    }
    measured = { inset, offsetTop, scale, height, innerHeight };
    return measured;
}

function subscribeToVisualViewport(notify: () => void): () => void {
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

export function useVisualViewport(): VisualViewportState {
    return useSyncExternalStore(subscribeToVisualViewport, visualViewport, () => CLOSED);
}
