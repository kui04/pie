/**
 * Whether the window is wide enough for the workspace's permanent session column.
 *
 * The width is written twice: as the Tailwind class that shows that column, and as
 * this query. Two things about the surfaces are JavaScript's rather than CSS's — a
 * column hidden by `display: none` still reads the sessions of the host, and a sheet
 * that is open holds the page itself (Radix puts `pointer-events: none` on the body)
 * — so a hand-written media query is warranted here.
 */

import { useSyncExternalStore } from "react";

/** Tailwind's `lg`, as `matchMedia` spells it. */
export const WIDE_WINDOW = "(min-width: 64rem)";

function subscribe(read: () => void): () => void {
    const query = window.matchMedia(WIDE_WINDOW);
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
}

export function useWideWindow(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia(WIDE_WINDOW).matches,
        // A window is not a thing this app renders outside a browser.
        () => false,
    );
}
