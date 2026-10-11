import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "cn";
import { Markdown } from "@/components";
import { Collapsible, CollapsibleTrigger, Marker, MarkerContent } from "@/components/ui";
import { REVEAL } from "@/lib/motion";
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
 * A thought that is still arriving says `Thinking…` in shadcn's marker with
 * its `shimmer` utility, so that a reader can tell a model at work from a
 * model that has finished thinking.
 */
export function ThinkingCard({ id, thinking, stillThinking = false }: ThinkingCardProps) {
    const [open, setOpen] = useState(false);
    const still = useReducedMotion();

    return (
        <Collapsible open={open} onOpenChange={setOpen} className="bg-card overflow-hidden rounded-md">
            <CollapsibleTrigger asChild>
                <button
                    id={`${id}-thinking`}
                    className="mb-2 flex w-full items-center gap-2 px-3 pt-2 text-left"
                    aria-controls={`${id}-body`}
                >
                    {stillThinking ? (
                        <Marker asChild role="status">
                            <span>
                                <MarkerContent className="shimmer text-body-md font-medium">Thinking…</MarkerContent>
                            </span>
                        </Marker>
                    ) : (
                        <span className="text-body-md text-muted-foreground font-medium">Thoughts</span>
                    )}
                </button>
            </CollapsibleTrigger>
            <CardBody id={`${id}-body`} open={open} transition={still ? { duration: 0 } : REVEAL}>
                <div className="mt-2 px-3 pb-2">
                    <Markdown id={`${id}-reasoning`} className="text-body-md text-muted-foreground">
                        {thinking}
                    </Markdown>
                </div>
            </CardBody>
            <CollapsibleTrigger asChild>
                <button
                    className="border-divider text-body-sm text-muted-foreground flex w-full items-center gap-2 border-t px-3 pt-2 pb-2 text-left"
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
