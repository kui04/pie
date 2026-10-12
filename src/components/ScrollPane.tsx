import * as React from "react";
import { cn } from "cn";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

function ScrollPane({
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
    bars?: "vertical" | "horizontal" | "both";
}) {
    return (
        <ScrollAreaPrimitive.Root data-slot="scroll-area" type={type} className={cn("relative", className)} {...props}>
            <ScrollAreaPrimitive.Viewport
                ref={viewportRef}
                data-slot="scroll-area-viewport"
                className={cn(
                    "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-3 focus-visible:outline-1 [&>div]:block!",
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

export { ScrollPane };
