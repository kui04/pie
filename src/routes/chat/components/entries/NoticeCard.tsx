import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "cn";
import { Markdown } from "@/components/Markdown";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { REVEAL } from "@/lib/motion";
import { CardBody } from "@/routes/chat/components/entries/CardBody";

export interface NoticeCardProps {
    /** The entry this card draws, as the base of its ids. */
    id: string;
    /** The bracketed word the header leads with, e.g. `[compaction]`. */
    label: string;
    /** One line of the notice, for the header. */
    summary: string;
    /** The whole of it, when that is more than the one line. */
    body: string | null;
}

/**
 * What the transcript says without being a message: a compaction, a branch
 * summary, a custom message of an extension. The label of the header is the
 * caller's word for it, because only the caller knows what the notice is.
 *
 * A notice of one line has nothing to open, so it is not a button.
 */
export function NoticeCard({ id, label, summary, body }: NoticeCardProps) {
    const [open, setOpen] = useState(false);
    const still = useReducedMotion();

    const header = (
        <>
            <span className="text-body-md text-foreground shrink-0 font-semibold">{label}</span>
            <span className="text-body-md text-muted-foreground min-w-0 flex-1 truncate">{summary}</span>
        </>
    );
    // One face for every card of the transcript: the design had this one tinted,
    // and a notice is a card like the rest - the label says what kind it is.
    const frame = "bg-card rounded-md";

    if (body === null) {
        return <div className={cn(frame, "flex items-baseline gap-2 px-3 py-2")}>{header}</div>;
    }

    return (
        <Collapsible open={open} onOpenChange={setOpen} className={frame}>
            <CollapsibleTrigger asChild>
                <button
                    id={`${id}-notice`}
                    className="mb-2 flex w-full items-center gap-2 px-3 pt-2 text-left"
                    aria-controls={`${id}-body`}
                >
                    {header}
                </button>
            </CollapsibleTrigger>
            <CardBody id={`${id}-body`} open={open} transition={still ? { duration: 0 } : REVEAL}>
                <div className="mt-2 px-3 pb-2">
                    <Markdown id={`${id}-text`} className="text-body-md">
                        {body}
                    </Markdown>
                </div>
            </CardBody>
            <CollapsibleTrigger asChild>
                <button
                    className="border-divider text-body-sm text-muted-foreground flex w-full items-center gap-2 border-t px-3 py-2 text-left"
                    aria-controls={`${id}-body`}
                >
                    <span className="flex-1">{open ? "Collapse to hide" : "Expand to read it all"}</span>
                    <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
                </button>
            </CollapsibleTrigger>
        </Collapsible>
    );
}
