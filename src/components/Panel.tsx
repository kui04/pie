import type { ComponentProps } from "react";
import { cn } from "cn";

/**
 * One pane of the window.
 *
 * A panel reads as a card — a 4px margin, a hairline, a large radius — only when
 * it has a neighbour to be separated from. One that is the whole window has
 * nothing to align to and nothing to be told apart from, so it drops all three.
 *
 * The count is the caller's to know: a panel cannot see its siblings, and any of
 * them may not be rendered at all.
 */
export interface PanelProps extends ComponentProps<"section"> {
    /** This panel is the whole window, so it fills the edge to edge. */
    solo?: boolean;
}

export function Panel({ solo = false, className, ...props }: PanelProps) {
    return (
        <section
            data-solo={solo}
            className={cn(
                "bg-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                !solo && "border-border m-1 rounded-lg border",
                className,
            )}
            {...props}
        />
    );
}
