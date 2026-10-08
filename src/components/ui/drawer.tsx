// The wrapper shadcn ships over vaul. Five things here are ours: the content's
// hairline names `border`, because a bare `border-t` would take `currentColor`;
// the scrim is the caller's, because a sheet's scrim is a tinted surface in this
// theme and not a black veil; a side drawer takes no width of its own, since the
// session column is `w-72` and the wrapper's `w-3/4` would outrank it; a title and
// a description name a colour only, because a size here would race the app's own
// type ramp: `cn` reads `text-body-md` as a colour, so the wrapper's `text-sm`
// would survive beside it and the stylesheet would pick the winner; and the grab
// bar carries `my-4` of its own, so a caller that pads the content's top adds to
// that gap - the bar's margin is the sheet's top edge, not the content's padding.
// `shadcn add drawer --diff` re-merges the rest.
import * as React from "react";
import { cn } from "cn";
import { Drawer as DrawerPrimitive } from "vaul";

function Drawer({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
    return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
    return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
    return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
    return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
    return (
        <DrawerPrimitive.Overlay
            data-slot="drawer-overlay"
            className={cn(
                "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs",
                className,
            )}
            {...props}
        />
    );
}

function DrawerContent({
    className,
    overlayClassName,
    children,
    ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
    /** The scrim under the sheet: this theme's own, so the caller names it. */
    overlayClassName?: string;
}) {
    return (
        <DrawerPortal data-slot="drawer-portal">
            <DrawerOverlay className={overlayClassName} />
            <DrawerPrimitive.Content
                data-slot="drawer-content"
                className={cn(
                    "group/drawer-content border-border bg-popover text-popover-foreground fixed z-50 flex h-auto flex-col text-sm data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:rounded-r-xl data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:rounded-l-xl data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm",
                    className,
                )}
                {...props}
            >
                <div className="bg-muted mx-auto my-4 hidden h-1 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
                {children}
            </DrawerPrimitive.Content>
        </DrawerPortal>
    );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="drawer-header"
            className={cn(
                "flex flex-col gap-0.5 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-0.5 md:text-left",
                className,
            )}
            {...props}
        />
    );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="drawer-footer" className={cn("mt-auto flex flex-col gap-2 p-4", className)} {...props} />;
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
    return <DrawerPrimitive.Title data-slot="drawer-title" className={cn("text-foreground", className)} {...props} />;
}

function DrawerDescription({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) {
    return (
        <DrawerPrimitive.Description
            data-slot="drawer-description"
            className={cn("text-muted-foreground", className)}
            {...props}
        />
    );
}

export {
    Drawer,
    DrawerPortal,
    DrawerOverlay,
    DrawerTrigger,
    DrawerClose,
    DrawerContent,
    DrawerHeader,
    DrawerFooter,
    DrawerTitle,
    DrawerDescription,
};
