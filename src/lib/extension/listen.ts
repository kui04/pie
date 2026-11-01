/**
 * The app's ear for what extensions ask and report, opened once for the whole window.
 *
 * The ask channel waits on an id, and Rust replays every ask it still waits on when the
 * window says it is ready. Therefore the listeners open before that word is said, and the
 * word is said once: a second replay would draw every waiting dialog again.
 */

import { toast } from "sonner";
import * as bridge from "@/lib/bridge";
import { useExtensionStore } from "./store";

/** The open listener set, while it lives. */
let listeners: Promise<bridge.Unsubscribe> | null = null;

/**
 * Opens the listeners of the extension channels, then says the window is ready.
 *
 * Idempotent: a second call answers the set that is already open.
 */
export function listenForExtensions(): Promise<void> {
    if (listeners !== null) return listeners.then(() => undefined);

    listeners = (async () => {
        const opened: bridge.Unsubscribe[] = [];
        try {
            opened.push(
                await bridge.onExtensionAsk((envelope) => {
                    const { host, session, request } = envelope.payload;
                    useExtensionStore.getState().asked({ host, session }, envelope.id, request);
                }),
            );
            opened.push(
                await bridge.onExtensionNotice((notice) => {
                    const say =
                        notice.kind === "error" ? toast.error : notice.kind === "warning" ? toast.warning : toast;
                    say(notice.message);
                }),
            );
            opened.push(
                await bridge.onExtensionEditorText((text) => {
                    useExtensionStore.getState().edited({ host: text.host, session: text.session }, text.text);
                }),
            );
            opened.push(
                await bridge.onExtensionStatus((status) => {
                    useExtensionStore
                        .getState()
                        .reported(
                            { host: status.host, session: status.session },
                            { key: status.key, text: status.text },
                        );
                }),
            );
            opened.push(
                await bridge.onExtensionTitle((title) => {
                    useExtensionStore.getState().titled({ host: title.host, session: title.session }, title.title);
                }),
            );

            // Every listener stands, so nothing that waits is lost when Rust replays.
            await bridge.readyForAnswer();

            return () => {
                for (const unsubscribe of opened) unsubscribe();
            };
        } catch (thrown) {
            for (const unsubscribe of opened) unsubscribe();
            listeners = null;
            throw thrown;
        }
    })();

    return listeners.then(() => undefined);
}

/** Drops the open listener set so the next `listenForExtensions` call subscribes fresh. */
export async function resetExtensionListeners(): Promise<void> {
    const current = listeners;
    listeners = null;
    if (current !== null) {
        try {
            const unsubscribe = await current;
            unsubscribe();
        } catch {
            // A failed setup already cleaned up its partial listeners.
        }
    }
}
