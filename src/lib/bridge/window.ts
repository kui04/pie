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

    const [stopResized, stopMoved] = await Promise.all([
        appWindow.onResized(() => void report()),
        appWindow.onMoved(() => void report()),
    ]);
    await report();

    return () => {
        stopResized();
        stopMoved();
    };
}
