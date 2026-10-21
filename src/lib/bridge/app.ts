/**
 * The app itself: which kind of machine this is, links that leave it, the marks
 * of the providers, and the window's own controls.
 *
 * The mirror of `src-tauri/src/commands/app.rs`, plus the one door of this
 * folder that does not go through `invoke`: the window. Tauri's window API is
 * the bridge itself rather than a plugin, and it holds no policy, so wrapping
 * `minimize` in a command would buy a round trip and nothing else.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, type Unsubscribe } from "./invoke";

/** The two words `platform` answers. */
export type Platform = "mobile" | "desktop";

/**
 * Which kind of machine this is.
 *
 * Asked of Rust rather than measured in CSS: a phone-shaped desktop window is
 * still a desktop and a tablet in landscape is still a phone, and both of those
 * questions have to be answered the same way.
 */
export function platform(): Promise<Platform> {
    return call<Platform>("platform");
}

/**
 * Asks the machine to open a link from the transcript.
 *
 * A webview is not the place to follow a link: it would take the window pie
 * speaks to pi through. Rust checks the scheme before anything is opened.
 */
export function openUrl(url: string): Promise<void> {
    return call<void>("open_url", { url });
}

/**
 * The mark of a provider from models.dev, as a data URL, or `null` when it has
 * none.
 *
 * Rust fetches it and keeps it for a day, so the popup of a model asks once. A
 * request that fails answers `null` too; the composer then draws its own icon.
 */
export function providerLogo(provider: string): Promise<string | null> {
    return call<string | null>("provider_logo", { provider });
}

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
    const report = async () => check(await windowControls.isMaximized());

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
