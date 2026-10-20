import {
    useEffect,
    useRef,
    useState,
    type ComponentProps,
    type ReactElement,
    type ReactNode,
    type RefObject,
} from "react";
import { cn } from "cn";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui";

const CLAMP = {
    1: "truncate",
    2: "line-clamp-2",
    3: "line-clamp-3",
} as const;

export type TruncatedTextOffset = Partial<Record<"top" | "right" | "bottom" | "left", number>>;

const ALIGN = {
    start: "text-start",
    center: "text-center",
    end: "text-end",
} as const;

export interface TruncatedTextProps extends Omit<ComponentProps<"span">, "children" | "content"> {
    /** The full text; it stays in the DOM, so screen readers read it without the card. */
    children: ReactNode;
    /** What the card shows; defaults to `children`. */
    content?: ReactNode;
    /**
     * A row or another existing trigger to wrap. The clipped text must then be
     * named through `measureRef`, because the trigger itself can be wider than it.
     */
    render?: ReactElement;
    /** The element whose overflow decides whether the card opens. */
    measureRef?: RefObject<HTMLSpanElement | null>;
    /** How many lines the trigger shows before it clips. */
    lines?: keyof typeof CLAMP;
    /** Where the card stands relative to the trigger. */
    side?: "top" | "bottom" | "left" | "right";
    /** How the card aligns with the trigger. */
    align?: keyof typeof ALIGN;
    /**
     * The gap on the side the card actually lands on, so a card that flips from
     * right to bottom can keep a different gap for each. A number applies to all
     * four sides; a side the object omits falls back to `sideOffset`.
     */
    offset?: number | TruncatedTextOffset;
    sideOffset?: number;
    alignOffset?: number;
    delay?: number;
    closeDelay?: number;
    /** Alignment of the trigger text and the card's own text. */
    textAlign?: keyof typeof ALIGN;
    /** A class for the card's text, such as `break-all` for a path. */
    contentClassName?: string;
}

/**
 * Text that keeps its full value in the DOM while showing one or more lines, and
 * opens a preview card with the full value only when it is clipped.
 *
 * The card is as wide as its content up to the space Base UI measured between the
 * trigger and the viewport edge. A value that fits therefore stays on one line
 * instead of wrapping at an arbitrary card width.
 */
export function TruncatedText({
    children,
    content,
    render,
    measureRef,
    lines = 1,
    side = "bottom",
    align = "start",
    offset,
    sideOffset = 8,
    alignOffset = 0,
    delay = 200,
    closeDelay = 100,
    textAlign,
    contentClassName,
    className,
    ...props
}: TruncatedTextProps) {
    const own = useRef<HTMLSpanElement>(null);
    const watched = measureRef ?? own;
    const [clipped, setClipped] = useState(false);
    const body = content === undefined ? children : content;
    const gap =
        offset === undefined || typeof offset === "number"
            ? (offset ?? sideOffset)
            : ({ side: landed }: { side: string }) => offset[landed as keyof TruncatedTextOffset] ?? sideOffset;

    useEffect(() => {
        const element = watched.current;
        if (element === null) return;
        const measure = () => {
            setClipped(
                element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
            );
        };
        const frame = requestAnimationFrame(measure);
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
        observer?.observe(element);
        window.addEventListener("resize", measure);
        return () => {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [children, lines, watched]);

    return (
        <HoverCard>
            <HoverCardTrigger
                render={
                    render ?? (
                        <span
                            ref={own}
                            data-slot="truncated-text"
                            className={cn(
                                "min-w-0",
                                lines === 1 && "block",
                                CLAMP[lines],
                                textAlign !== undefined && ALIGN[textAlign],
                                className,
                            )}
                            {...props}
                        />
                    )
                }
                delay={delay}
                closeDelay={closeDelay}
            >
                {children}
            </HoverCardTrigger>
            {clipped && body !== null && body !== undefined && (
                <HoverCardContent
                    side={side}
                    align={align}
                    sideOffset={gap}
                    alignOffset={alignOffset}
                    className="
                        w-max max-w-(--available-width,calc(100vw-2rem)) bg-card p-3 duration-150 ease-out
                        motion-safe:transition-[opacity,scale]
                        motion-safe:data-ending-style:scale-95 motion-safe:data-ending-style:opacity-0
                        motion-safe:data-starting-style:scale-95 motion-safe:data-starting-style:opacity-0
                    "
                >
                    <div
                        className={cn(
                            "text-body-md wrap-break-word text-foreground",
                            textAlign !== undefined && ALIGN[textAlign],
                            contentClassName,
                        )}
                    >
                        {body}
                    </div>
                </HoverCardContent>
            )}
        </HoverCard>
    );
}
