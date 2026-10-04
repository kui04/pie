/**
 * The window's frame: the app mark at one end, the three window keys at the
 * other, and no title — a session's name belongs to the session bar.
 *
 * Each key decides nothing: minimise, toggle-maximise and close go to the
 * window, which owns the window's size, state and life. The bar reflects only
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
    "hover:bg-surface-container-high focus-visible:outline-primary size-6 p-1 rounded-sm shrink-0 bg-transparent transition-colors duration-50 ease-in-out";

export interface TitleBarProps {
    /**
     * The app's mark, decorative and never read out.
     *
     * Optional because there is no mark asset to point at yet, and an invented
     * one would be worse than an empty slot.
     */
    mark?: string;
}

export function TitleBar({ mark }: TitleBarProps) {
    const [maximized, setMaximized] = useState(false);

    // The window maximizes itself as readily as the key does — a double-click,
    // a drag to the top edge — so it is asked rather than assumed.
    useEffect(() => {
        let stop: (() => void) | undefined;
        let cancelled = false;
        void watchWindow(setMaximized).then((unsubscribe) => {
            if (cancelled) unsubscribe();
            else stop = unsubscribe;
        });
        return () => {
            cancelled = true;
            stop?.();
        };
    }, []);

    return (
        <header
            id="title-bar-root"
            data-tauri-drag-region
            className="bg-background text-foreground flex w-full shrink-0 items-center gap-3 p-1 font-sans"
        >
            {mark === undefined ? null : <img id="title-bar-mark" src={mark} alt="" className="size-4 shrink-0" />}
            {/* `ms-auto` rather than `space-between` on the bar: the keys stay at the end
                whether or not a mark is there to push them. */}
            <div id="title-bar-keys" className="ms-auto flex shrink-0 items-center gap-1">
                <button
                    id="title-bar-minimize"
                    type="button"
                    aria-label="Minimize"
                    onClick={() => void windowControls.minimize()}
                    className={cn(KEY, "text-foreground")}
                >
                    <Minus id="title-bar-minimize-icon" className="size-4" aria-hidden />
                </button>
                <button
                    id="title-bar-maximize"
                    type="button"
                    aria-label={maximized ? "Restore" : "Maximize"}
                    onClick={() => void windowControls.toggleMaximize()}
                    className={cn(KEY, "text-foreground")}
                >
                    <AnimatePresence initial={false} mode="wait">
                        <motion.span
                            key={maximized ? "maximized" : "restored"}
                            id="title-bar-maximize-icon"
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
                    id="title-bar-close"
                    type="button"
                    aria-label="Close"
                    onClick={() => void windowControls.close()}
                    className={cn(KEY, "hover:bg-destructive hover:text-destructive-foreground")}
                >
                    <X id="title-bar-close-icon" className="size-4" aria-hidden />
                </button>
            </div>
        </header>
    );
}
