import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Unsubscribe } from "./invoke";

/**
 * The window's own keys.
 *
 * The window plugin rather than `invoke`, but the same kind of exit: nothing
 * above this folder talks to Tauri.
 */
export const windowControls = {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    isMaximized: () => getCurrentWindow().isMaximized(),
};

/**
 * Calls `check` whenever the window is resized or moved, and once right away —
 * maximizing is the window's own business, and the window may arrive already
 * maximized.
 */
export async function watchWindow(check: (maximized: boolean) => void): Promise<Unsubscribe> {
    const appWindow = getCurrentWindow();
    const report = async () => check(await appWindow.isMaximized());

    // One at a time, and released again if the next one fails: a listener that arrived
    // before the failure would otherwise stay on the window with nobody holding its
    // release.
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
