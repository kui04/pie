import * as React from "react";
import { cn } from "cn";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

function ScrollPane({
    className,
    viewport,
    viewportRef,
    viewportClassName,
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
    bars?: "vertical" | "horizontal" | "both";
}) {
    return (
        <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
            {viewport ? (
                <ScrollAreaPrimitive.Viewport render={viewport}>{children}</ScrollAreaPrimitive.Viewport>
            ) : (
                <ScrollAreaPrimitive.Viewport
                    ref={viewportRef}
                    data-slot="scroll-area-viewport"
                    tabIndex={-1}
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
            {bars !== "horizontal" && <ScrollBar />}
            {bars !== "vertical" && <ScrollBar orientation="horizontal" />}
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
                "flex touch-none select-none",
                "data-vertical:w-2 data-vertical:px-0.5 data-vertical:py-px",
                "data-horizontal:h-2 data-horizontal:px-px data-horizontal:py-0.5",
                className,
            )}
            {...props}
        >
            <ScrollAreaPrimitive.Thumb
                data-slot="scroll-area-thumb"
                className="bg-outline hover:bg-foreground relative flex-1 rounded-full"
            />
        </ScrollAreaPrimitive.Scrollbar>
    );
}

export { ScrollPane };
