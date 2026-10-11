import type { ComponentProps } from "react";
import { cn } from "cn";

/** Which sides of a region keep clear of the system bars. */
export type SafeAreaSide = "top" | "bottom" | "vertical" | "all";

const SIDES: Record<SafeAreaSide, string> = {
    top: "pt-safe",
    bottom: "pb-safe",
    vertical: "pt-safe pb-safe",
    all: "pt-safe pb-safe pl-safe pr-safe",
};

export interface SafeAreaProps extends ComponentProps<"div"> {
    /** The sides to keep out. Both by default, which is what a column wants. */
    side?: SafeAreaSide;
}

/**
 * A region that keeps out of a phone's system bars.
 *
 * A phone draws its status bar and its navigation bar over the window (Android
 * enforces edge to edge from target 35), and reports how much room they take as
 * the `safe-area-inset-*` the `*-safe` utilities read. This is where a region
 * takes that room: the element wraps what must stay out, and the pane behind it
 * keeps painting to the screen's edge, which is what edge to edge is for. On a
 * desktop every inset is zero, so the same tree needs no branch.
 *
 * The wrapper is the *outer* element on purpose: `cn` merges by property, so a
 * caller's `pt-6` on this element would drop the inset, while a padding on the
 * children adds to it.
 */
export function SafeArea({ side = "vertical", className, ...props }: SafeAreaProps) {
    return <div {...props} className={cn(SIDES[side], className)} />;
}
