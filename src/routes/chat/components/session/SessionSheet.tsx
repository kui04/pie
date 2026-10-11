/**
 * The session list of a narrow window: a sheet over the transcript.
 *
 * From `lg` the same list is a permanent column instead, and the button that opens
 * this sheet lives below that breakpoint. A window that grows past it lets the sheet
 * go: a hidden sheet is not a closed one, and the body has no pointer events of its
 * own while a modal is up (see `use-wide-window.ts`).
 */

import { useEffect, type ReactNode } from "react";
import { cn } from "cn";
import { Sheet, SheetContent, SheetTitle } from "@/components";
import { useWideWindow } from "@/hooks/use-wide-window";

export interface SessionSheetProps {
    /** The id of the sheet's surface; the panel inside it has its own. */
    id: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
    /** Merged last, so a caller can overrule the frame (a preview pins it open). */
    className?: string;
}

export function SessionSheet({ id, open, onOpenChange, children, className }: SessionSheetProps) {
    const wide = useWideWindow();

    useEffect(() => {
        if (wide) onOpenChange(false);
    }, [wide, onOpenChange]);

    return (
        // Vaul assumes the bottom of the screen unless it is told: a drawer anchored
        // to the left edge has to arrive from the left and be dragged sideways.
        <Sheet open={open} onOpenChange={onOpenChange} direction="left">
            <SheetContent
                id={id}
                overlayClassName="bg-surface-container-highest/70 fixed inset-0 z-40 lg:hidden"
                className={cn(
                    // A square left edge and a round right one: the sheet arrives
                    // from the edge it is anchored to. The clip is what holds it:
                    // the panel inside paints its own square background, and
                    // nothing cuts it to the corner without this.
                    "bg-surface-dim border-border w-72 max-w-[85%] overflow-hidden rounded-r-xl border-r outline-none",
                    "lg:hidden",
                    className,
                )}
            >
                <SheetTitle className="sr-only">Sessions</SheetTitle>
                {children}
            </SheetContent>
        </Sheet>
    );
}
