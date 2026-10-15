import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Markdown } from "@/components";
import { Collapsible, CollapsibleTrigger } from "@/components/ui";

export interface NoticeProps {
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
export function Notice({ id, label, summary, body }: NoticeProps) {
    const [open, setOpen] = useState(false);

    const header = (
        <>
            <span className="text-body-md text-foreground shrink-0 font-semibold">{label}</span>
            <span className="text-body-md text-muted-foreground min-w-0 flex-1 truncate">{summary}</span>
        </>
    );
    if (body === null) {
        return <div className="bg-card flex items-baseline gap-2 rounded-md px-3 py-2">{header}</div>;
    }

    return (
        <Collapsible open={open} onOpenChange={setOpen} className="bg-card rounded-md">
            <CollapsibleTrigger
                render={
                    <button
                        id={`${id}-notice`}
                        className="mb-2 flex w-full items-center gap-2 px-3 pt-2 text-left"
                        aria-controls={`${id}-body`}
                    />
                }
            >
                {header}
            </CollapsibleTrigger>
            {open && (
                <div id={`${id}-body`} className="mt-2 px-3 pb-2">
                    <Markdown id={`${id}-text`}>{body}</Markdown>
                </div>
            )}
            <CollapsibleTrigger
                render={
                    <button
                        className="border-divider text-body-sm text-muted-foreground flex w-full items-center gap-2 border-t px-3 py-2 text-left"
                        aria-controls={`${id}-body`}
                    />
                }
            >
                <span className="flex-1">{open ? "Collapse to hide" : "Expand to read it all"}</span>
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
            </CollapsibleTrigger>
        </Collapsible>
    );
}
