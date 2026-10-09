/**
 * Whether the window is maximized, for the keys that draw it.
 *
 * The window maximizes itself as readily as the key does — a double-click, a drag
 * to the top edge — so it is asked rather than assumed, and asked again whenever
 * it is resized or moved. This hook is the seam of that stream: the key reads the
 * answer and never subscribes (`.agents/rules/state.md`).
 *
 * Where there is no window manager to ask — a story, a test, a browser preview —
 * the keys stay as they are: an absent answer is not a failure to report.
 */

import { useEffect, useState } from "react";
import { watchWindow } from "@/lib/bridge";

export function useMaximized(): boolean {
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        let stop: (() => void) | undefined;
        let cancelled = false;
        watchWindow(setMaximized)
            .then((unsubscribe) => {
                if (cancelled) unsubscribe();
                else stop = unsubscribe;
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            stop?.();
        };
    }, []);

    return maximized;
}
