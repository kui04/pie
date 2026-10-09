import * as React from "react";
import { cn } from "cn";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

/*
 * The registry's file with five deliberate changes:
 *
 * 1. `viewportRef` and `viewportClassName`: the viewport is inside Radix's own
 *    Root, and pie needs both from outside - the transcript hands the element to
 *    virtua's `scrollRef`, and a call site pads it;
 * 2. the bar is mounted for good (pie's default is `type="always"`, not the
 *    registry's caller-chosen `hover`) so it can fade in and out rather than
 *    appear and vanish - how it fades is `src/index.css`'s business, beside the
 *    engine's own bar, so both read the same in one place;
 * 3. the bar is the design's 8px lane with a 4px pill inset 2px either side, sized
 *    per orientation - which the vendored `data-vertical:`/`data-horizontal:`
 *    variants make possible;
 * 4. the thumb is the design's `outline` grey, brighter under the pointer, rather
 *    than the registry's `border`, which is the tiles' own colour and invisible
 *    over these panes;
 * 5. the layer Radix scrolls through is forced back to `block` (see the comment at
 *    the viewport), or a row meant to truncate a long name would widen the pane.
 */
function ScrollArea({
    className,
    viewportRef,
    viewportClassName,
    type = "always",
    bars = "vertical",
    children,
    ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
    viewportRef?: React.Ref<HTMLDivElement>;
    viewportClassName?: string;
    /** Which bars this area can need: a table scrolls one way, a log the other. */
    bars?: "vertical" | "horizontal" | "both";
}) {
    return (
        <ScrollAreaPrimitive.Root data-slot="scroll-area" type={type} className={cn("relative", className)} {...props}>
            <ScrollAreaPrimitive.Viewport
                ref={viewportRef}
                data-slot="scroll-area-viewport"
                className={cn(
                    "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
                    // Radix wraps what it scrolls in a div of its own, with an inline
                    // `display: table; min-width: 100%`. A table is as wide as its
                    // content asks to be, so a row that truncates a long name pushed
                    // that layer wider than the pane and spilled out of it. The layer
                    // stays (it carries the `min-width: 100%`) but lays out as the
                    // block it should be - and only an important declaration moves an
                    // inline style, which is why this one carries the bang.
                    "[&>div]:!block",
                    viewportClassName,
                )}
            >
                {children}
            </ScrollAreaPrimitive.Viewport>
            {bars !== "horizontal" && <ScrollBar />}
            {bars !== "vertical" && <ScrollBar orientation="horizontal" />}
            <ScrollAreaPrimitive.Corner />
        </ScrollAreaPrimitive.Root>
    );
}

function ScrollBar({
    className,
    orientation = "vertical",
    ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
    return (
        <ScrollAreaPrimitive.ScrollAreaScrollbar
            data-slot="scroll-area-scrollbar"
            orientation={orientation}
            className={cn(
                "flex touch-none select-none",
                "data-vertical:w-2 data-vertical:px-0.5 data-vertical:py-px",
                "data-horizontal:h-2 data-horizontal:px-px data-horizontal:py-0.5",
                className,
            )}
            {...props}
        >
            <ScrollAreaPrimitive.ScrollAreaThumb
                data-slot="scroll-area-thumb"
                className="bg-outline hover:bg-foreground relative flex-1 rounded-full"
            />
        </ScrollAreaPrimitive.ScrollAreaScrollbar>
    );
}

export { ScrollArea, ScrollBar };
