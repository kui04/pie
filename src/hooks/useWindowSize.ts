/**
 * The window's layout size.
 *
 * This is the viewport a keyboard does not change; the visual viewport is the
 * smaller area that remains while one is open.
 */

import { useSyncExternalStore } from "react";

export interface WindowSize {
    windowHeight: number;
    windowWidth: number;
}

const NO_WINDOW: WindowSize = { windowHeight: 0, windowWidth: 0 };

let measured: WindowSize = NO_WINDOW;
let measuredKey = "";

function windowSize(): WindowSize {
    const height = window.innerHeight;
    const width = window.innerWidth;
    const key = `${width}:${height}`;
    if (key !== measuredKey) {
        measuredKey = key;
        measured = { windowHeight: height, windowWidth: width };
    }
    return measured;
}

function subscribeToWindowSize(read: () => void): () => void {
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
}

export function useWindowSize(): WindowSize {
    return useSyncExternalStore(subscribeToWindowSize, windowSize, () => NO_WINDOW);
}
