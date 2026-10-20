/**
 * A key in a dialog's footer: full width under a thumb, a compact rounded key on
 * a desktop. The frame says which host it is in, so callers do not repeat that.
 */

import type { ComponentProps } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui";
import { useDialogFrame } from "./context";

export type DialogActionProps = ComponentProps<typeof Button>;

export function DialogAction({ className, children, type = "button", ...props }: DialogActionProps) {
    const { mobile } = useDialogFrame();
    return (
        <Button type={type} className={cn(mobile ? "h-10 flex-1" : "rounded-lg px-4 py-3", className)} {...props}>
            <span className="text-label-lg font-medium">{children}</span>
        </Button>
    );
}
