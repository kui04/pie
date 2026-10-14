import * as React from "react";
import { cn } from "cn";
import { mergeProps } from "@base-ui/react/merge-props";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";

/**
 * A popover whose panel stands above an element that is not its trigger: the
 * composer's command list above the message box, opened by typing rather than
 * by a press. The registry's popover has no Anchor part, and Base UI's
 * positioner takes the anchored element itself (`anchor`), so the element is
 * published here and read by the content. Everything else - the root, the
 * trigger, the header parts - is `@/components/ui`.
 */
const AnchoredPopoverAnchorContext = React.createContext<{
    anchor: Element | null;
    setAnchor: (anchor: Element | null) => void;
} | null>(null);

function AnchoredPopover({
    children,
    ...props
}: Omit<PopoverPrimitive.Root.Props, "children"> & { children?: React.ReactNode }) {
    const [anchor, setAnchor] = React.useState<Element | null>(null);
    const context = React.useMemo(() => ({ anchor, setAnchor }), [anchor]);
    return (
        <PopoverPrimitive.Root {...props}>
            <AnchoredPopoverAnchorContext.Provider value={context}>{children}</AnchoredPopoverAnchorContext.Provider>
        </PopoverPrimitive.Root>
    );
}

function AnchoredPopoverAnchor({ render, ...props }: useRender.ComponentProps<"div">) {
    const context = React.useContext(AnchoredPopoverAnchorContext);
    return useRender({
        defaultTagName: "div",
        render,
        ref: (element: Element | null) => {
            context?.setAnchor(element);
        },
        props: mergeProps<"div">({ "data-slot": "popover-anchor" } as React.ComponentProps<"div">, props),
    });
}

function AnchoredPopoverContent({
    className,
    align = "center",
    alignOffset = 0,
    side = "bottom",
    sideOffset = 4,
    ...props
}: PopoverPrimitive.Popup.Props &
    Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
    const context = React.useContext(AnchoredPopoverAnchorContext);
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Positioner
                align={align}
                alignOffset={alignOffset}
                side={side}
                sideOffset={sideOffset}
                anchor={context?.anchor ?? undefined}
                className="isolate z-50"
            >
                <PopoverPrimitive.Popup
                    data-slot="popover-content"
                    className={cn(
                        "bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg p-2.5 text-sm shadow-md ring-1 outline-hidden duration-100",
                        className,
                    )}
                    {...props}
                />
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}

export { AnchoredPopover, AnchoredPopoverAnchor, AnchoredPopoverContent };
