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
        const asked = await bridge.onExtensionAsk((envelope) => {
            const { host, session, request } = envelope.payload;
            useExtensionStore.getState().asked({ host, session }, envelope.id, request);
        });
        try {
            const noticed = await bridge.onExtensionNotice((notice) => {
                const say = notice.kind === "error" ? toast.error : notice.kind === "warning" ? toast.warning : toast;
                say(notice.message);
            });
            const typed = await bridge.onExtensionEditorText((text) => {
                useExtensionStore.getState().edited({ host: text.host, session: text.session }, text.text);
            });
            const reported = await bridge.onExtensionStatus((status) => {
                useExtensionStore
                    .getState()
                    .reported({ host: status.host, session: status.session }, { key: status.key, text: status.text });
            });

            // Both listeners stand, so nothing that waits is lost when Rust replays.
            await bridge.readyForAnswer();

            return () => {
                asked();
                noticed();
                reported();
                typed();
            };
        } catch (thrown) {
            asked();
            listeners = null;
            throw thrown;
        }
    })();

    return listeners.then(() => undefined);
}
