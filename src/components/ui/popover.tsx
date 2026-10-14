"use client";

import * as React from "react";
import { cn } from "cn";
import { mergeProps } from "@base-ui/react/merge-props";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";

/**
 * The element a trigger-less popover stands above, one per popover. Base UI
 * has no Anchor part: the positioner takes the element itself (`anchor`), so
 * the anchor below publishes its node here and the content below reads it.
 * A popover without an anchor keeps Base UI's default and stands above its
 * trigger.
 */
const PopoverAnchorContext = React.createContext<{
    anchor: Element | null;
    setAnchor: (anchor: Element | null) => void;
} | null>(null);

function Popover({ children, ...props }: PopoverPrimitive.Root.Props) {
    const [anchor, setAnchor] = React.useState<Element | null>(null);
    const anchorContext = React.useMemo(() => ({ anchor, setAnchor }), [anchor]);
    if (typeof children === "function") {
        return (
            <PopoverPrimitive.Root data-slot="popover" {...props}>
                {children}
            </PopoverPrimitive.Root>
        );
    }
    return (
        <PopoverPrimitive.Root data-slot="popover" {...props}>
            <PopoverAnchorContext.Provider value={anchorContext}>{children}</PopoverAnchorContext.Provider>
        </PopoverPrimitive.Root>
    );
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
    return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
    className,
    align = "center",
    alignOffset = 0,
    side = "bottom",
    sideOffset = 4,
    ...props
}: PopoverPrimitive.Popup.Props &
    Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
    const anchorContext = React.useContext(PopoverAnchorContext);
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Positioner
                align={align}
                alignOffset={alignOffset}
                side={side}
                sideOffset={sideOffset}
                anchor={anchorContext?.anchor ?? undefined}
                className="isolate z-50"
            >
                <PopoverPrimitive.Popup
                    data-slot="popover-content"
                    className={cn(
                        "bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg p-2.5 text-sm shadow-md ring-1 outline-hidden duration-100",
                        className,
                    )}
                    {...props}
                />
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}

function PopoverAnchor({ render, ...props }: useRender.ComponentProps<"div">) {
    const anchorContext = React.useContext(PopoverAnchorContext);
    return useRender({
        defaultTagName: "div",
        render,
        ref: (instance: Element | null) => {
            anchorContext?.setAnchor(instance);
        },
        props: mergeProps<"div">({ "data-slot": "popover-anchor" } as React.ComponentProps<"div">, props),
    });
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="popover-header" className={cn("flex flex-col gap-0.5 text-sm", className)} {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
    return <PopoverPrimitive.Title data-slot="popover-title" className={cn("font-medium", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
    return (
        <PopoverPrimitive.Description
            data-slot="popover-description"
            className={cn("text-muted-foreground", className)}
            {...props}
        />
    );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
