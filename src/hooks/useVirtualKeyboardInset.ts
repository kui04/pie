/**
 * The on-screen keyboard's rectangle, measured the way the CSS `keyboard-inset-*`
 * environment variables describe it: top, right, bottom and left insets from the
 * viewport edge, with the rectangle's width and height.
 *
 * Where the VirtualKeyboard API exists, its `boundingRect` is the authority and
 * `geometrychange` reports movement. That API has limited availability, so it is
 * only consulted when it also reports that the keyboard overlays content. Other
 * WebViews expose only the visual viewport, whose height shrinks for a keyboard
 * at the bottom edge; that fallback is the same rectangle the CSS environment
 * variables describe.
 *
 * A gap below the threshold is chrome noise, not a keyboard, and pinch zoom
 * shrinks the visual viewport without opening one.
 */

import { useSyncExternalStore } from "react";
import { subscribeToVisualViewport } from "./useVisualViewport";

/** A gap below this is chrome noise (URL bar), not a keyboard. */
const OPEN_THRESHOLD = 100;

export interface VirtualKeyboardInset {
    /** The keyboard's top inset from the viewport edge. */
    insetTop: number;
    insetRight: number;
    insetBottom: number;
    insetLeft: number;
    insetWidth: number;
    insetHeight: number;
}

const NO_KEYBOARD: VirtualKeyboardInset = {
    insetTop: 0,
    insetRight: 0,
    insetBottom: 0,
    insetLeft: 0,
    insetWidth: 0,
    insetHeight: 0,
};

interface KeyboardRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface VirtualKeyboardLike extends EventTarget {
    overlaysContent: boolean;
    boundingRect: KeyboardRect;
}

function virtualKeyboard(): VirtualKeyboardLike | null {
    return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard ?? null;
}

let measured: VirtualKeyboardInset = NO_KEYBOARD;
let measuredKey = "";

function keyboardFromRect(rect: KeyboardRect, viewportWidth: number, viewportHeight: number): VirtualKeyboardInset {
    const insetTop = Math.max(0, rect.y);
    const insetLeft = Math.max(0, rect.x);
    const insetRight = Math.max(0, viewportWidth - rect.x - rect.width);
    const insetBottom = Math.max(0, viewportHeight - rect.y - rect.height);
    const key = `${insetTop}:${insetRight}:${insetBottom}:${insetLeft}:${rect.width}:${rect.height}`;
    if (key !== measuredKey) {
        measuredKey = key;
        measured = {
            insetTop,
            insetRight,
            insetBottom,
            insetLeft,
            insetWidth: rect.width,
            insetHeight: rect.height,
        };
    }
    return measured;
}

function virtualKeyboardInset(): VirtualKeyboardInset {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const keyboard = virtualKeyboard();
    if (keyboard !== null && keyboard.overlaysContent) {
        const rect = keyboard.boundingRect;
        if (rect.width > 0 && rect.height > 0) {
            return keyboardFromRect(rect, viewportWidth, viewportHeight);
        }
    }

    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return NO_KEYBOARD;

    const scale = viewport.scale;
    if (scale !== undefined && Math.abs(scale - 1) > 0.01) return NO_KEYBOARD;

    const height = viewportHeight - viewport.height;
    if (height < OPEN_THRESHOLD) return NO_KEYBOARD;

    return keyboardFromRect(
        { x: 0, y: viewportHeight - height, width: viewportWidth, height },
        viewportWidth,
        viewportHeight,
    );
}

function subscribeToVirtualKeyboard(notify: () => void): () => void {
    const stopVisual = subscribeToVisualViewport(notify);
    const keyboard = virtualKeyboard();
    if (keyboard === null) return stopVisual;
    keyboard.addEventListener("geometrychange", notify);
    return () => {
        stopVisual();
        keyboard.removeEventListener("geometrychange", notify);
    };
}

export function useVirtualKeyboardInset(): VirtualKeyboardInset {
    return useSyncExternalStore(subscribeToVirtualKeyboard, virtualKeyboardInset, () => NO_KEYBOARD);
}
