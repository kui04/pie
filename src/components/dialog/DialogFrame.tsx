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
import { useIsMobile, useVirtualKeyboardInset, useVisualViewport } from "@/hooks";
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

    /**
     * Whether a phone drawer may shrink for the on-screen keyboard. A sheet with
     * its own fixed height turns this off: it keeps its place while the visual
     * viewport pans for the keyboard.
     */
    fitKeyboard?: boolean;

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
    fitKeyboard = true,
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
    const { insetHeight: keyboardInset } = useVirtualKeyboardInset();
    const { offsetTop: viewportOffset } = useVisualViewport();
    const generated = useId();
    const baseId = id ?? generated;
    const descriptionId = `${baseId}-description`;
    const hasDescription = description !== undefined && description !== null;
    const hasChildren = children !== undefined && children !== null && children !== false;
    const ariaDescribedBy = hasDescription ? descriptionId : describedBy;
    const titleClass = "text-(length:--text-title-md) leading-6 font-normal";
    const drawerStyle =
        keyboardInset > 0
            ? fitKeyboard
                ? {
                      ...style,
                      maxHeight: `calc(100dvh - ${keyboardInset}px - env(safe-area-inset-top, 0px))`,
                  }
                : viewportOffset > 0
                  ? { ...style, bottom: -viewportOffset }
                  : style
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
                            `
                                border-border bg-card px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none
                                data-[nested-drawer-open]:opacity-0
                            `,
                            className,
                            drawerClassName,
                        )}
                        aria-describedby={ariaDescribedBy}
                        style={drawerStyle}
                    >
                        {showClose ? (
                            <div className={cn("flex items-center justify-between gap-2", showSwipeHandle && "mt-4")}>
                                <DrawerTitle className={titleClass}>{title}</DrawerTitle>
                                {closeKey("drawer")}
                            </div>
                        ) : (
                            <DrawerTitle className={cn(titleClass, showSwipeHandle && "mt-4")}>{title}</DrawerTitle>
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
                        {hasChildren && <div className="mt-4 flex min-h-0 flex-1 flex-col">{children}</div>}
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
                            <DialogTitle className={titleClass}>{title}</DialogTitle>
                            {closeKey("dialog")}
                        </div>
                    ) : (
                        <DialogTitle className={titleClass}>{title}</DialogTitle>
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
