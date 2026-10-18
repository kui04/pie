import * as React from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { cn } from "cn";

export interface TruncatedTextProps extends React.HTMLAttributes<HTMLSpanElement> {
    /** The content displayed and measured for truncation. */
    children: React.ReactNode;
    /** Optional full content shown in the tooltip popup. Defaults to `children`. */
    fullText?: React.ReactNode;
    /**
     * Side on which the popup bubble and triangle arrow appear.
     * "top" | "bottom" | "left" | "right".
     * Defaults to "bottom".
     */
    align?: "top" | "bottom" | "left" | "right";
    /**
     * Alias for `align` matching Base UI terminology.
     */
    side?: "top" | "bottom" | "left" | "right";
    /**
     * Alignment along the side: "start" | "center" | "end".
     * Defaults to "start".
     */
    sideAlign?: "start" | "center" | "end";
    /**
     * Distance in pixels between the trigger element and the popup.
     * Defaults to 6.
     */
    sideOffset?: number;
    /**
     * Delay in milliseconds before showing the tooltip on hover.
     * Defaults to 300.
     */
    delay?: number;
    /**
     * Additional CSS classes for the popup bubble container.
     */
    popupClassName?: string;
    /**
     * Override truncation detection:
     * - `true`: always show tooltip on hover
     * - `false`: never show tooltip on hover
     * - `undefined`: automatic detection based on element scrollWidth and clientWidth
     */
    force?: boolean;
}

export const TruncatedText = React.forwardRef<HTMLSpanElement, TruncatedTextProps>(function TruncatedText(
    {
        children,
        fullText,
        align = "bottom",
        side,
        sideAlign = "center",
        sideOffset = 8,
        delay = 300,
        popupClassName,
        className,
        force,
        onMouseEnter,
        ...spanProps
    },
    forwardedRef,
) {
    const triggerRef = React.useRef<HTMLSpanElement | null>(null);
    const [, setIsTruncated] = React.useState(false);

    const setRefs = React.useCallback(
        (node: HTMLSpanElement | null) => {
            triggerRef.current = node;
            if (typeof forwardedRef === "function") {
                forwardedRef(node);
            } else if (forwardedRef !== null && forwardedRef !== undefined) {
                forwardedRef.current = node;
            }
        },
        [forwardedRef],
    );

    const checkTruncation = React.useCallback(() => {
        const el = triggerRef.current;
        if (!el) return false;
        // Sub-pixel tolerance to avoid false positives
        const truncated = el.scrollWidth > el.clientWidth + 1;
        setIsTruncated(truncated);
        return truncated;
    }, []);

    React.useEffect(() => {
        checkTruncation();

        const el = triggerRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;

        const observer = new ResizeObserver(() => {
            checkTruncation();
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [checkTruncation, children, fullText]);

    const resolvedSide = side ?? align;
    const content = fullText ?? children;

    const handleOpenChange = (open: boolean, details: Tooltip.Root.ChangeEventDetails) => {
        if (open) {
            const truncated = checkTruncation();
            const shouldOpen = force === true || (force === undefined && truncated);
            if (!shouldOpen) {
                details.cancel();
            }
        }
    };

    // Avoid running tailwind-merge on custom text ramp tokens (e.g. text-body-md)
    const resolvedClassName = className ? `truncate block ${className}` : "truncate block";

    return (
        <Tooltip.Provider delay={delay} closeDelay={0} timeout={150}>
            <Tooltip.Root onOpenChange={handleOpenChange}>
                <Tooltip.Trigger
                    render={<span />}
                    ref={setRefs}
                    className={resolvedClassName}
                    onMouseEnter={(e) => {
                        checkTruncation();
                        onMouseEnter?.(e);
                    }}
                    {...spanProps}
                >
                    {children}
                </Tooltip.Trigger>
                <Tooltip.Portal>
                    <Tooltip.Positioner
                        side={resolvedSide}
                        align={sideAlign}
                        sideOffset={sideOffset}
                        className="isolate z-50"
                    >
                        <Tooltip.Popup
                            className={cn(
                                "border-border bg-popover relative z-50 max-w-sm rounded-md border px-2.5 py-1",
                                "text-popover-foreground text-xs break-all shadow-md select-text",
                                "origin-(--transform-origin) duration-100 ease-out",
                                "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
                                "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
                                "data-[side=bottom]:slide-in-from-top-1",
                                "data-[side=top]:slide-in-from-bottom-1",
                                "data-[side=left]:slide-in-from-right-1",
                                "data-[side=right]:slide-in-from-left-1",
                                popupClassName,
                            )}
                        >
                            <Tooltip.Arrow
                                className={cn(
                                    "relative block h-1.5 w-3 overflow-clip",
                                    "data-[side=bottom]:-top-1.5",
                                    "data-[side=top]:-bottom-1.5 data-[side=top]:rotate-180",
                                    "data-[side=left]:right-[-9px] data-[side=left]:rotate-90",
                                    "data-[side=right]:left-[-9px] data-[side=right]:-rotate-90",
                                    "before:bg-popover before:border-border before:absolute before:bottom-0 before:left-1/2 before:size-[8.5px] before:transform-[translate(-50%,50%)_rotate(45deg)] before:border before:content-['']",
                                )}
                            />
                            {content}
                        </Tooltip.Popup>
                    </Tooltip.Positioner>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    );
});
