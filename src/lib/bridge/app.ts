/**
 * The app itself: its platform, its links, the marks of providers, and the answer
 * to an ask.
 *
 * The mirror of `src-tauri/src/commands/app.rs`.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Answer } from "./ask";
import { call, type Unsubscribe } from "./invoke";

/**
 * Answers one ask.
 *
 * `false` means no ask waited under that id: it timed out, or another answer won.
 */
export function answer(id: number, answer: Answer): Promise<boolean> {
    return call<boolean>("answer", { id, answer });
}

/**
 * Tells Rust that the listeners of this window are up.
 *
 * Rust then replays every ask it still waits on, with what is left of its budget.
 */
export function readyForAnswer(): Promise<void> {
    return call<void>("ready_for_answer");
}

/** Which kind of machine pie runs on. */
export type Platform = "mobile" | "desktop";

/** The kind of machine pie runs on. */
export function platform(): Promise<Platform> {
    return call<Platform>("platform");
}

/**
 * Opens a link in the browser of the machine.
 *
 * Rust refuses a scheme pie does not open, and the failure carries the link.
 */
export function openUrl(url: string): Promise<void> {
    return call<void>("open_url", { url });
}

/**
 * The mark of one provider as base64 SVG, or `null` when pie has none.
 *
 * Rust caches a mark for a day and a failed fetch for half an hour, so a caller may
 * ask on every render.
 */
export function providerLogo(provider: string): Promise<string | null> {
    return call<string | null>("provider_logo", { provider });
}

/**
 * The window's own keys.
 *
 * The window plugin rather than `invoke`, but the same kind of exit: nothing above
 * this folder talks to Tauri.
 */
export const windowControls = {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    isMaximized: () => getCurrentWindow().isMaximized(),
};

/** Calls `check` on every resize and move, and once right away. */
export async function watchWindow(check: (maximized: boolean) => void): Promise<Unsubscribe> {
    const appWindow = getCurrentWindow();
    const report = async () => check(await windowControls.isMaximized());

    // A listener that arrived before a failure would stay on the window with nobody
    // holding its release, so each is released again here.
    let off: Unsubscribe[] = [];
    try {
        off = [await appWindow.onResized(() => void report()), await appWindow.onMoved(() => void report())];
        await report();
    } catch (thrown) {
        for (const stop of off) stop();
        throw thrown;
    }

    return () => {
        for (const stop of off) stop();
    };
}
