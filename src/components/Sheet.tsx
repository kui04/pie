import * as React from "react";
import { cn } from "cn";
import { Drawer as DrawerPrimitive } from "vaul";

function Sheet({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
    return <DrawerPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
    return <DrawerPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
    return <DrawerPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
    return <DrawerPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
    return (
        <DrawerPrimitive.Overlay
            data-slot="sheet-overlay"
            className={cn(
                "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs",
                className,
            )}
            {...props}
        />
    );
}

function SheetContent({
    className,
    overlayClassName,
    children,
    ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
    /** The scrim under the sheet: this theme's own, so the caller names it. */
    overlayClassName?: string;
}) {
    return (
        <SheetPortal data-slot="sheet-portal">
            <SheetOverlay className={overlayClassName} />
            <DrawerPrimitive.Content
                data-slot="sheet-content"
                className={cn(
                    "group/sheet-content border-border bg-popover text-popover-foreground fixed z-50 flex h-auto flex-col text-sm data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:rounded-r-xl data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:rounded-l-xl data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm",
                    className,
                )}
                {...props}
            >
                <div className="bg-muted mx-auto my-4 hidden h-1 w-25 shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/sheet-content:block" />
                {children}
            </DrawerPrimitive.Content>
        </SheetPortal>
    );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="sheet-header"
            className={cn(
                "flex flex-col gap-0.5 p-4 group-data-[vaul-drawer-direction=bottom]/sheet-content:text-center group-data-[vaul-drawer-direction=top]/sheet-content:text-center md:gap-0.5 md:text-left",
                className,
            )}
            {...props}
        />
    );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2 p-4", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
    return <DrawerPrimitive.Title data-slot="sheet-title" className={cn("text-foreground", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) {
    return (
        <DrawerPrimitive.Description
            data-slot="sheet-description"
            className={cn("text-muted-foreground", className)}
            {...props}
        />
    );
}

export {
    Sheet,
    SheetPortal,
    SheetOverlay,
    SheetTrigger,
    SheetClose,
    SheetContent,
    SheetHeader,
    SheetFooter,
    SheetTitle,
    SheetDescription,
};
