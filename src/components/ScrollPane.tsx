import * as React from "react";
import { cn } from "cn";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

function ScrollPane({
    className,
    viewport,
    viewportRef,
    viewportClassName,
    viewportStyle,
    bars = "vertical",
    children,
    ...props
}: ScrollAreaPrimitive.Root.Props & {
    /**
     * The element that scrolls, for a region whose own part draws it: the pane's bar and
     * corner stay here and read the region through it, and the children go inside it.
     * `viewportRef` and `viewportClassName` are the pane's own viewport and do not apply.
     */
    viewport?: React.ReactElement;
    viewportRef?: React.Ref<HTMLDivElement>;
    viewportClassName?: string;
    viewportStyle?: React.CSSProperties;
    /** Which bars the pane draws; `none` for a pane whose own controls page it. */
    bars?: "vertical" | "horizontal" | "both" | "none";
}) {
    // Confine overflow to active axes so gestures chain to enclosing containers.
    const overflowStyle: React.CSSProperties =
        bars === "horizontal"
            ? { overflowX: "scroll", overflowY: "hidden" }
            : bars === "vertical"
              ? { overflowX: "hidden", overflowY: "scroll" }
              : { overflow: "scroll" };

    return (
        <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
            {viewport ? (
                <ScrollAreaPrimitive.Viewport render={viewport}>{children}</ScrollAreaPrimitive.Viewport>
            ) : (
                <ScrollAreaPrimitive.Viewport
                    ref={viewportRef}
                    data-slot="scroll-area-viewport"
                    tabIndex={-1}
                    style={{ ...overflowStyle, ...viewportStyle }}
                    className={cn("size-full rounded-[inherit] outline-none [&>div]:block!", viewportClassName)}
                >
                    {/* Base UI's content wrapper carries `min-width: fit-content`, which inside a
                        scroll container is the content's *min-content*: one line of text that cannot
                        wrap - a truncated row - is a whole pane wide, and the wrapper, and every
                        `w-full` row that fills it, grows past the pane with it. A pane that stands
                        its ground sideways is that wide on purpose and keeps it. */}
                    <ScrollAreaPrimitive.Content className={cn(bars === "vertical" && "min-w-0!")}>
                        {children}
                    </ScrollAreaPrimitive.Content>
                </ScrollAreaPrimitive.Viewport>
            )}
            {bars !== "horizontal" && bars !== "none" && <ScrollBar />}
            {bars !== "vertical" && bars !== "none" && <ScrollBar orientation="horizontal" />}
            <ScrollAreaPrimitive.Corner />
        </ScrollAreaPrimitive.Root>
    );
}

function ScrollBar({ className, orientation = "vertical", ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
    return (
        <ScrollAreaPrimitive.Scrollbar
            data-slot="scroll-area-scrollbar"
            orientation={orientation}
            // The stylesheet fades this bar in and out, and a bar that only
            // mounts when the region overflows could not be faded: it would
            // appear. It stays mounted for that reason.
            keepMounted
            className={cn(
                `
                    flex touch-none select-none
                    data-horizontal:h-2 data-horizontal:px-px data-horizontal:py-0.5
                    data-vertical:w-2 data-vertical:flex-col data-vertical:px-0.5 data-vertical:py-px
                `,
                className,
            )}
            {...props}
        >
            <ScrollAreaPrimitive.Thumb
                data-slot="scroll-area-thumb"
                className="relative rounded-full bg-outline hover:bg-foreground"
            />
        </ScrollAreaPrimitive.Scrollbar>
    );
}

export { ScrollPane };
