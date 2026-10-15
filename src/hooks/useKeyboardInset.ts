import { useSyncExternalStore } from "react";

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

function snapshot(): number {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return 0;
    // Pinch zoom shrinks the visual viewport with no keyboard in sight.
    if (viewport.scale !== undefined && Math.abs(viewport.scale - 1) > 0.01) return 0;
    const gap = window.innerHeight - viewport.height;
    return gap >= OPEN_THRESHOLD ? gap : 0;
}

function subscribe(notify: () => void): () => void {
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
    return useSyncExternalStore(subscribe, snapshot, () => 0);
}
