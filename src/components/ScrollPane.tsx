import * as React from "react";
import { cn } from "cn";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

function ScrollPane({
    className,
    viewportRef,
    viewportClassName,
    bars = "vertical",
    children,
    ...props
}: ScrollAreaPrimitive.Root.Props & {
    viewportRef?: React.Ref<HTMLDivElement>;
    viewportClassName?: string;
    bars?: "vertical" | "horizontal" | "both";
}) {
    return (
        <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
            <ScrollAreaPrimitive.Viewport
                ref={viewportRef}
                data-slot="scroll-area-viewport"
                className={cn(
                    "focus-visible:ring-ring/50 size-full rounded-[inherit]",
                    "transition-[color,box-shadow] outline-none focus-visible:ring-3",
                    "focus-visible:outline-1 [&>div]:block!",
                    viewportClassName,
                )}
            >
                <ScrollAreaPrimitive.Content>{children}</ScrollAreaPrimitive.Content>
            </ScrollAreaPrimitive.Viewport>
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
