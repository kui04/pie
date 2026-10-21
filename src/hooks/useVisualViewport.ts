/**
 * The visual viewport: the part of the layout viewport the reader can see.
 *
 * A keyboard can shrink it and pan it without changing the layout viewport.
 * The offset is where its top-left corner starts inside the layout viewport;
 * width, height and scale describe the visible rectangle itself.
 */

import { useSyncExternalStore } from "react";

export interface VisualViewportState {
    offsetLeft: number;
    offsetTop: number;
    height: number;
    width: number;
    scale: number;
}

const NO_VIEWPORT: VisualViewportState = {
    offsetLeft: 0,
    offsetTop: 0,
    height: 0,
    width: 0,
    scale: 1,
};

let measured: VisualViewportState = NO_VIEWPORT;
let measuredKey = "";

function visualViewport(): VisualViewportState {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) {
        const height = window.innerHeight;
        const width = window.innerWidth;
        const key = `0:0:${width}:${height}:1`;
        if (key !== measuredKey) {
            measuredKey = key;
            measured = { offsetLeft: 0, offsetTop: 0, height, width, scale: 1 };
        }
        return measured;
    }

    const left = viewport.offsetLeft ?? 0;
    const top = viewport.offsetTop ?? 0;
    const height = viewport.height;
    const width = viewport.width;
    const scale = viewport.scale ?? 1;
    const key = `${left}:${top}:${width}:${height}:${scale}`;
    if (key !== measuredKey) {
        measuredKey = key;
        measured = { offsetLeft: left, offsetTop: top, height, width, scale };
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

export function useVisualViewport(): VisualViewportState {
    return useSyncExternalStore(subscribeToVisualViewport, visualViewport, () => NO_VIEWPORT);
}
