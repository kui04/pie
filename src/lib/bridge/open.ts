import { call } from "@/lib/bridge/invoke";

/**
 * Asks the machine to open a link from the transcript.
 *
 * A webview is not the place to follow a link: it would take the window pie
 * speaks to pi through. Rust checks the scheme before anything is opened.
 */
export function openUrl(url: string): Promise<void> {
    return call<void>("open_url", { url });
}
