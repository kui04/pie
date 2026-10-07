import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "cn";
import { Markdown } from "@/components/Markdown";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { REVEAL, SHIMMER, SHIMMER_SWEEP } from "@/lib/motion";
import { CardBody } from "@/routes/chat/components/entries/CardBody";

export interface ThinkingCardProps {
    /** The entry this card draws, as the base of its ids. */
    id: string;
    /** The reasoning, as the model wrote it. */
    thinking: string;
    /** Whether the model is still writing it. */
    stillThinking?: boolean;
}

/**
 * What the model thought before it answered.
 *
 * A closed card does not hold the reasoning at all: the header says that there
 * is reasoning to read, and a reader asks for it. Pi's own card is the same shape,
 * and opens from the header row and from the row under it.
 *
 * A thought that is still arriving says `Thinking…` and shimmers, so that a
 * reader can tell a model at work from a model that has finished thinking.
 */
export function ThinkingCard({ id, thinking, stillThinking = false }: ThinkingCardProps) {
    const [open, setOpen] = useState(false);
    const still = useReducedMotion();

    return (
        <Collapsible
            open={open}
            onOpenChange={setOpen}
            className="border-border bg-card overflow-hidden rounded-md border"
        >
            <CollapsibleTrigger asChild>
                <button
                    id={`${id}-thinking`}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                    aria-controls={`${id}-body`}
                >
                    {stillThinking ? (
                        // The light that runs along the word has to be brighter than
                        // what stands around it, or the sweep is invisible: the two
                        // greys of the palette are the same lightness in dark mode,
                        // so the base of the text is dimmed and only the middle of
                        // the gradient is the bright one.
                        <motion.span
                            className="text-body-md from-muted-foreground/35 via-foreground to-muted-foreground/35 bg-linear-to-r bg-[length:200%_100%] bg-clip-text font-medium text-transparent"
                            animate={still ? undefined : SHIMMER_SWEEP}
                            transition={SHIMMER}
                        >
                            Thinking…
                        </motion.span>
                    ) : (
                        <span className="text-body-md text-muted-foreground font-medium">Thoughts</span>
                    )}
                </button>
            </CollapsibleTrigger>
            <CardBody id={`${id}-body`} open={open} transition={still ? { duration: 0 } : REVEAL}>
                <div className="px-3 pb-2">
                    <Markdown id={`${id}-reasoning`} className="text-body-md text-muted-foreground">
                        {thinking}
                    </Markdown>
                </div>
            </CardBody>
            <CollapsibleTrigger asChild>
                <button
                    className="border-border text-label-md text-muted-foreground flex w-full items-center gap-2 border-t px-3 pt-2 pb-2 text-left"
                    aria-controls={`${id}-body`}
                >
                    <span className="flex-1">
                        {open ? "Collapse to hide model thoughts" : "Expand to view model thoughts"}
                    </span>
                    <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
                </button>
            </CollapsibleTrigger>
        </Collapsible>
    );
}
