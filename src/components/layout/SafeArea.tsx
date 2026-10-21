import type { ComponentProps, CSSProperties } from "react";

/** Which sides of a region keep clear of the system bars. */
export type SafeAreaSide = "top" | "bottom" | "vertical" | "all";

type SafeAreaStyle = CSSProperties & {
    "--safe-area-top"?: string;
    "--safe-area-right"?: string;
    "--safe-area-bottom"?: string;
    "--safe-area-left"?: string;
};

const INSETS: Record<SafeAreaSide, SafeAreaStyle> = {
    top: {
        "--safe-area-top": "env(safe-area-inset-top, 0px)",
        paddingTop: "var(--safe-area-top)",
    },
    bottom: {
        "--safe-area-bottom": "env(safe-area-inset-bottom, 0px)",
        paddingBottom: "var(--safe-area-bottom)",
    },
    vertical: {
        "--safe-area-top": "env(safe-area-inset-top, 0px)",
        "--safe-area-bottom": "env(safe-area-inset-bottom, 0px)",
        paddingTop: "var(--safe-area-top)",
        paddingBottom: "var(--safe-area-bottom)",
    },
    all: {
        "--safe-area-top": "env(safe-area-inset-top, 0px)",
        "--safe-area-right": "env(safe-area-inset-right, 0px)",
        "--safe-area-bottom": "env(safe-area-inset-bottom, 0px)",
        "--safe-area-left": "env(safe-area-inset-left, 0px)",
        paddingTop: "var(--safe-area-top)",
        paddingRight: "var(--safe-area-right)",
        paddingBottom: "var(--safe-area-bottom)",
        paddingLeft: "var(--safe-area-left)",
    },
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
 * the `safe-area-inset-*` the `env()` values here read. This is where a region
 * takes that room: the element wraps what must stay out, and the pane behind it
 * keeps painting to the screen's edge, which is what edge to edge is for. On a
 * desktop every inset is zero, so the same tree needs no branch.
 *
 * The wrapper is the *outer* element on purpose: the inset is an inline style,
 * so a caller's padding on this element cannot remove it, while a padding on
 * the children adds to it.
 */
export function SafeArea({ side = "vertical", className, style, ...props }: SafeAreaProps) {
    return <div {...props} className={className} style={{ ...style, ...INSETS[side] }} />;
}
