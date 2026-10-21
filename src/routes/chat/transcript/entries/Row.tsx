import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "cn";
import { Icon, TruncatedText } from "@/components";
import { Marker } from "@/components/ui";
import { useMotion } from "@/hooks";

export interface RowProps {
    /** The entry this row draws, as the base of its ids. */
    id: string;
    /** The 16px glyph of the row's kind. */
    glyph: ReactNode;
    /** What the row is called: a tool's word, a prompt, or a phrase that streams. */
    name: ReactNode;
    /** How the name is coloured: a call the model made, a command the reader ran, or quiet. */
    tone?: "model" | "user-run" | "quiet";
    /** What the call aimed at: a path, a pattern, a command. One line, truncated. */
    target?: string | null;
    /** What the row's end says: a clock, a ring while it runs, a mark when it failed, or a fold's chevron. */
    end?: ReactNode;
    /**
     * Whether the body carries a line of its own - the way a quote does. A row inside a fold
     * leaves that to the fold's rail; a row standing alone draws one under itself.
     */
    quote?: boolean;
    /** Whether the row is open. */
    open: boolean;
    /** Toggles the row. */
    onToggle: () => void;
    /** The whole of what the row produced, revealed under it at the row's own text column. */
    children?: ReactNode;
}

/**
 * The anatomy of one row, shared by every kind the transcript draws.
 *
 * A 24px slot holds a 16px glyph at its left, on the plane the transcript is drawn on, so a
 * fold's rail can thread behind it; then the name - whose colour says who did the work - what
 * the call aimed at, and whatever its end says. The body waits under all of it, at the column
 * the name stands in, so a table of rows reads as one column of words with a gutter of glyphs.
 */
export function Row({
    id,
    glyph,
    name,
    tone = "model",
    target,
    end,
    quote = false,
    open,
    onToggle,
    children,
}: RowProps) {
    const { reveal } = useMotion();
    // A body is what makes the row a fold. A row with nothing under it stays a
    // plain row: no button, no toggle, and no empty body.
    const foldable = children !== undefined && children !== null && children !== false && children !== "";

    const content = (
        <>
            <Icon className="relative z-10 justify-start bg-surface" aria-hidden>
                {glyph}
            </Icon>
            <span
                className={cn(
                    // The name keeps its own width on one line, however long: what the
                    // row aimed at truncates behind it, never the other way round.
                    "shrink-0 text-body-md whitespace-nowrap trim",
                    tone !== "quiet" && "font-medium",
                    tone === "model" && "text-primary-text",
                    tone === "user-run" && "text-violet",
                )}
            >
                {name}
            </span>
            {target !== null && target !== undefined && target !== "" && (
                <TruncatedText content={target} offset={{ top: 6, right: 12, bottom: 6, left: 12 }}>
                    {target}
                </TruncatedText>
            )}
            {end !== undefined && <span className="ml-auto flex shrink-0 items-center gap-1.5">{end}</span>}
        </>
    );

    return (
        <div id={id} className="flex min-w-0 flex-col">
            {foldable ? (
                <Marker
                    render={
                        <button
                            id={`${id}-row`}
                            aria-expanded={open}
                            aria-controls={open ? `${id}-body` : undefined}
                            onClick={onToggle}
                            className="min-h-10 w-full cursor-pointer text-left hover:text-foreground sm:min-h-8.5"
                        />
                    }
                >
                    {content}
                </Marker>
            ) : (
                <Marker className="min-h-10 w-full text-left sm:min-h-8.5">{content}</Marker>
            )}
            <AnimatePresence initial={false}>
                {foldable && open && (
                    <motion.div key="body" id={`${id}-body`} className="overflow-hidden" {...reveal}>
                        <div className="relative mt-1 mb-2 flex min-w-0 flex-col gap-1 pl-8">
                            {/* The line of a body that stands alone: it starts under the glyph rather than
                                through it, and runs the body - a quote's bar, not a fold's rail. It is
                                the same 2px line scaled to a centred 1px, like the fold's rail. */}
                            {quote && (
                                <span
                                    aria-hidden
                                    className="absolute inset-y-0 left-2 z-0 flex w-3 -translate-x-1/2 justify-center"
                                >
                                    <span className="h-full w-0.5 origin-center scale-x-50 bg-divider" />
                                </span>
                            )}
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
