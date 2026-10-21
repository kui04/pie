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
 * How far the soft keyboard reaches into the window, in CSS pixels.
 *
 * Reads `window.visualViewport`: when the IME opens without resizing the
 * layout viewport, the visual viewport shrinks and the gap is the keyboard.
 * When the engine resizes the layout instead (`interactive-widget`), both
 * shrink together, the gap is zero, and no extra pad is needed. Zero until
 * measured, and zero where the API is absent.
 */

/** A gap below this is chrome noise (URL bar), not a keyboard. */
const OPEN_THRESHOLD = 100;

function keyboardInset(): number {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return 0;
    // Pinch zoom shrinks the visual viewport with no keyboard in sight.
    if (viewport.scale !== undefined && Math.abs(viewport.scale - 1) > 0.01) return 0;
    const gap = window.innerHeight - viewport.height;
    return gap >= OPEN_THRESHOLD ? gap : 0;
}

function subscribeToKeyboard(notify: () => void): () => void {
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
    return () => {
        window.cancelAnimationFrame(frame);
        viewport.removeEventListener("resize", changed);
        viewport.removeEventListener("scroll", changed);
        window.removeEventListener("resize", changed);
    };
}

export function useKeyboardInset(): number {
    return useSyncExternalStore(subscribeToKeyboard, keyboardInset, () => 0);
}
