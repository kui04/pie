import type { ComponentProps } from "react";
import { cn } from "cn";

/**
 * The box every icon stands in: 24px square with the 16px glyph centred, so icons
 * line up across a row whatever their source. `cn` can move the glyph or colour it
 * for a call site that needs a different alignment.
 */
export function Icon({ className, ...props }: ComponentProps<"span">) {
    return (
        <span
            data-slot="icon"
            className={cn("inline-flex size-6 shrink-0 items-center justify-center [&_svg]:size-4", className)}
            {...props}
        />
    );
}
