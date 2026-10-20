/**
 * One question in the shell the app gives it: a dialog on a desktop and a sheet
 * on a phone, with the title, description, body and keys all in the same places.
 *
 * The frame keeps no state of its own. The caller owns `open` and every answer;
 * the frame only draws the shape and hands its body the mobile flag.
 */

import { useId, type CSSProperties, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerTitle,
} from "@/components/ui";
import { useIsMobile, useKeyboardInset } from "@/hooks";
import { Icon } from "../Icon";
import { DialogFrameContext } from "./context";

export interface DialogFrameProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Pins which host to draw, for previews and tests. */
    isMobile?: boolean;

    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    actions?: ReactNode;

    /** The element the host should focus when it opens. */
    initialFocus?: RefObject<HTMLElement | null>;
    /** The base of the generated description and close ids. */
    id?: string;

    /** Styles both hosts share. */
    className?: string;
    drawerClassName?: string;
    dialogClassName?: string;
    descriptionClassName?: string;

    /** The drawer handle is on by default; a nested drawer can leave it off. */
    showSwipeHandle?: boolean;
    /** A close key level with the title. */
    showClose?: boolean;
    closeLabel?: string;
    /** For a body that names its own description element. */
    describedBy?: string;

    style?: CSSProperties;
}

export function DialogFrame({
    open,
    onOpenChange,
    isMobile,
    title,
    description,
    children,
    actions,
    initialFocus,
    id,
    className,
    drawerClassName,
    dialogClassName,
    descriptionClassName,
    showSwipeHandle = true,
    showClose = false,
    closeLabel = "Close",
    describedBy,
    style,
}: DialogFrameProps) {
    const mobileIs = useIsMobile();
    const mobile = isMobile ?? mobileIs;
    const keyboardInset = useKeyboardInset();
    const generated = useId();
    const baseId = id ?? generated;
    const descriptionId = `${baseId}-description`;
    const hasDescription = description !== undefined && description !== null;
    const ariaDescribedBy = hasDescription ? descriptionId : describedBy;
    const drawerStyle =
        keyboardInset > 0
            ? {
                  ...style,
                  paddingBottom: `calc(1.5rem + env(safe-area-inset-bottom) + ${keyboardInset}px)`,
              }
            : style;

    const closeKey = (host: "drawer" | "dialog") => (
        <Button
            id={`${baseId}-${host}-close`}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={closeLabel}
            onClick={() => onOpenChange(false)}
        >
            <Icon>
                <X aria-hidden />
            </Icon>
        </Button>
    );

    if (mobile) {
        return (
            <DialogFrameContext.Provider value={{ mobile }}>
                <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="down" showSwipeHandle={showSwipeHandle}>
                    <DrawerContent
                        initialFocus={initialFocus}
                        className={cn(
                            "border-border bg-card px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none",
                            className,
                            drawerClassName,
                        )}
                        aria-describedby={ariaDescribedBy}
                        style={drawerStyle}
                    >
                        {showClose ? (
                            <div className="flex items-center justify-between gap-2">
                                <DrawerTitle className="text-(length:--text-title-md) leading-6 font-normal">
                                    {title}
                                </DrawerTitle>
                                {closeKey("drawer")}
                            </div>
                        ) : (
                            <DrawerTitle className="text-(length:--text-title-md) leading-6 font-normal">
                                {title}
                            </DrawerTitle>
                        )}
                        {hasDescription && (
                            <DrawerDescription
                                id={descriptionId}
                                className={cn(
                                    "mt-4 text-(length:--text-body-md) leading-5 text-muted-foreground",
                                    descriptionClassName,
                                )}
                            >
                                {description}
                            </DrawerDescription>
                        )}
                        {children}
                        {actions !== undefined && actions !== null && (
                            <DrawerFooter className="mt-8 flex flex-row gap-4 p-0">{actions}</DrawerFooter>
                        )}
                    </DrawerContent>
                </Drawer>
            </DialogFrameContext.Provider>
        );
    }

    return (
        <DialogFrameContext.Provider value={{ mobile }}>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    showCloseButton={false}
                    initialFocus={initialFocus}
                    className={cn(
                        "rounded-xl border border-border bg-card p-6 text-foreground",
                        className,
                        dialogClassName,
                    )}
                    aria-describedby={ariaDescribedBy}
                    style={style}
                >
                    {showClose ? (
                        <div className="flex items-center justify-between gap-2">
                            <DialogTitle className="text-(length:--text-title-md) leading-6 font-normal">
                                {title}
                            </DialogTitle>
                            {closeKey("dialog")}
                        </div>
                    ) : (
                        <DialogTitle className="text-(length:--text-title-md) leading-6 font-normal">
                            {title}
                        </DialogTitle>
                    )}
                    {hasDescription && (
                        <DialogDescription
                            id={descriptionId}
                            className={cn(
                                "text-(length:--text-body-md) leading-5 text-muted-foreground",
                                descriptionClassName,
                            )}
                        >
                            {description}
                        </DialogDescription>
                    )}
                    {children}
                    {actions !== undefined && actions !== null && (
                        <DialogFooter className="mt-0 flex flex-row justify-end gap-4 border-0 bg-transparent">
                            {actions}
                        </DialogFooter>
                    )}
                </DialogContent>
            </Dialog>
        </DialogFrameContext.Provider>
    );
}
