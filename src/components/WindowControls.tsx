/**
 * The window's three keys: minimize, toggle-maximize and close.
 *
 * Each key decides nothing: minimize, toggle-maximize and close go to the
 * window, which owns the window's size, state and life. The keys reflect only
 * whether the window is maximized, and only to swap the middle key's glyph and
 * name.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "cn";
import { Copy, Minus, PictureInPicture2, X } from "lucide-react";
import { windowControls, watchWindow } from "@/lib/bridge";
import { SWAP, SWAPPED_IN, SWAPPED_OUT } from "@/lib/motion";

/** A 24px hit area, the WCAG 2.5.8 minimum. */
const KEY =
    "hover:bg-muted focus-visible:outline-primary size-6 p-1 rounded-sm shrink-0 bg-transparent transition-colors duration-50 ease-in-out";

/**
 * The keys sit at the end of the bar whatever the bar carries on the left, so
 * they ask for that end themselves: on the gate they are all that is in it.
 */
export function WindowControls() {
    const [maximized, setMaximized] = useState(false);

    // The window maximizes itself as readily as the key does — a double-click,
    // a drag to the top edge — so it is asked rather than assumed. Where there
    // is no window manager to ask — a story, a test, a browser preview — the
    // keys stay as they are: an absent answer is not a failure to report.
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

    return (
        <span id="window_controllers" className="ms-auto flex shrink-0 items-center gap-1">
            <button
                id="window-minimize"
                type="button"
                aria-label="Minimize"
                onClick={() => void windowControls.minimize()}
                className={cn(KEY, "text-foreground")}
            >
                <Minus id="window-minimize-icon" className="size-4" aria-hidden />
            </button>
            <button
                id="window-maximize"
                type="button"
                aria-label={maximized ? "Restore" : "Maximize"}
                onClick={() => void windowControls.toggleMaximize()}
                className={cn(KEY, "text-foreground")}
            >
                <AnimatePresence initial={false} mode="wait">
                    <motion.span
                        key={maximized ? "maximized" : "restored"}
                        id="window-maximize-icon"
                        className="flex"
                        initial={SWAPPED_IN}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={SWAPPED_OUT}
                        transition={SWAP}
                    >
                        {maximized ? (
                            <Copy className="size-4" aria-hidden />
                        ) : (
                            <PictureInPicture2 className="size-4" aria-hidden />
                        )}
                    </motion.span>
                </AnimatePresence>
            </button>
            {/* The one key that paints itself: closing is what a person aims at. */}
            <button
                id="window-close"
                type="button"
                aria-label="Close"
                onClick={() => void windowControls.close()}
                className={cn(KEY, "hover:bg-destructive hover:text-destructive-foreground")}
            >
                <X id="window-close-icon" className="size-4" aria-hidden />
            </button>
        </span>
    );
}
