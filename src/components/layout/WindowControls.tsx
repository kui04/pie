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
import { useMaximized, useMotion } from "@/hooks";
import { windowControls } from "@/lib/bridge";
import { Icon } from "../Icon";

/**
 * The keys sit at the end of the bar whatever the bar carries on the left, so
 * they ask for that end themselves: on the gate they are all that is in it.
 */
export function WindowControls() {
    const maximized = useMaximized();
    const { swap } = useMotion();

    return (
        <span id="window_controllers" className="ms-auto flex shrink-0 items-center gap-1">
            <button
                id="window-minimize"
                type="button"
                aria-label="Minimize"
                onClick={() => void windowControls.minimize()}
                className="
                    inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-transparent p-1
                    text-foreground transition-colors duration-50 ease-in-out
                    hover:bg-accent/50
                    focus-visible:outline-primary
                "
            >
                <Icon>
                    <Minus id="window-minimize-icon" aria-hidden />
                </Icon>
            </button>
            <button
                id="window-maximize"
                type="button"
                aria-label={maximized ? "Restore" : "Maximize"}
                onClick={() => void windowControls.toggleMaximize()}
                className="
                    inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-transparent p-1
                    text-foreground transition-colors duration-50 ease-in-out
                    hover:bg-accent/50
                    focus-visible:outline-primary
                "
            >
                <AnimatePresence initial={false} mode="wait">
                    <motion.span
                        key={maximized ? "maximized" : "restored"}
                        id="window-maximize-icon"
                        className="flex"
                        {...swap}
                    >
                        {maximized ? (
                            <Icon>
                                <Copy aria-hidden />
                            </Icon>
                        ) : (
                            <Icon>
                                <PictureInPicture2 aria-hidden />
                            </Icon>
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
                className="
                    inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-transparent p-1
                    transition-colors duration-50 ease-in-out
                    hover:bg-destructive hover:text-destructive-foreground
                    focus-visible:outline-primary
                "
            >
                <Icon>
                    <X id="window-close-icon" aria-hidden />
                </Icon>
            </button>
        </span>
    );
}
