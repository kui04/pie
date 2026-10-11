/**
 * The window's three keys: minimize, toggle-maximize and close.
 *
 * Each key decides nothing: minimize, toggle-maximize and close go to the
 * window, which owns the window's size, state and life. The keys reflect only
 * whether the window is maximized, and only to swap the middle key's glyph and
 * name.
 */

import { AnimatePresence, motion } from "motion/react";
import { Copy, Minus, PictureInPicture2, X } from "lucide-react";
import { useMaximized } from "@/hooks/use-maximized";
import { windowControls } from "@/lib/bridge";

/**
 * The keys sit at the end of the bar whatever the bar carries on the left, so
 * they ask for that end themselves: on the gate they are all that is in it.
 */
export function WindowControls() {
    const maximized = useMaximized();

    return (
        <span id="window_controllers" className="ms-auto flex shrink-0 items-center gap-1">
            <button
                id="window-minimize"
                type="button"
                aria-label="Minimize"
                onClick={() => void windowControls.minimize()}
                className="hover:bg-muted focus-visible:outline-primary text-foreground size-6 shrink-0 rounded-sm bg-transparent p-1 transition-colors duration-50 ease-in-out"
            >
                <Minus id="window-minimize-icon" className="size-4" aria-hidden />
            </button>
            <button
                id="window-maximize"
                type="button"
                aria-label={maximized ? "Restore" : "Maximize"}
                onClick={() => void windowControls.toggleMaximize()}
                className="hover:bg-muted focus-visible:outline-primary text-foreground size-6 shrink-0 rounded-sm bg-transparent p-1 transition-colors duration-50 ease-in-out"
            >
                <AnimatePresence initial={false} mode="wait">
                    <motion.span
                        key={maximized ? "maximized" : "restored"}
                        id="window-maximize-icon"
                        className="flex"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 1.1 }}
                        transition={{ type: "tween", duration: 0.15 }}
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
                className="focus-visible:outline-primary hover:bg-destructive hover:text-destructive-foreground size-6 shrink-0 rounded-sm bg-transparent p-1 transition-colors duration-50 ease-in-out"
            >
                <X id="window-close-icon" className="size-4" aria-hidden />
            </button>
        </span>
    );
}
