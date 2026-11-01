/**
 * Joins the window to the extension channels, once.
 *
 * The listeners belong to the window and not to a screen: a dialog waits on pi, and a
 * screen that arrives later still finds it. `listenForExtensions` is idempotent, so the
 * double mount of StrictMode costs nothing.
 */

import { useEffect } from "react";
import * as bridge from "@/lib/bridge";
import { listenForExtensions } from "@/lib/extension/listen";

export function useExtensionSync(): void {
    useEffect(() => {
        void listenForExtensions().catch((thrown: unknown) => {
            bridge.log.warn("the extension channels did not open", {
                reason: bridge.asPieError(thrown).message,
            });
        });
    }, []);
}
