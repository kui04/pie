import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Markdown } from "@/components";
import { Marker, MarkerIcon } from "@/components/ui";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { customGlyph } from "@/routes/chat/transcript/entries/tool-glyph";

export interface CustomMessageProps {
    /** The entry this row draws, as the base of its ids. */
    id: string;
    /** The word the header leads with, e.g. `Review`. */
    label: string;
    /** The whole content when it is one line, else nothing: no excerpts. */
    summary: string;
    /** The whole of it, when that is more than the one line. */
    body: string | null;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/**
 * A custom message of an extension: the label is the caller's word for it,
 * because only the caller knows what the message is. A message of one line
 * has nothing to open, so it is not a button.
 */
export function CustomMessage({ id, label, summary, body, quote = false }: CustomMessageProps) {
    // A message is read closed; the reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const open = manual ?? false;

    if (body === null) {
        return (
            <Marker id={id} className="min-h-10 w-full pr-1 sm:min-h-[34px]">
                <MarkerIcon className="bg-surface relative z-10 flex size-6 items-center">{customGlyph()}</MarkerIcon>
                <span className="text-body-md text-violet trim shrink-0 font-medium whitespace-nowrap">{label}</span>
                {summary !== "" && (
                    <span className="min-w-0 truncate" title={summary}>
                        {summary}
                    </span>
                )}
            </Marker>
        );
    }

    return (
        <Row
            id={id}
            glyph={customGlyph()}
            name={
                <span className="flex items-center gap-2">
                    <span className="text-violet trim font-medium">{label}</span>
                    {/* One icon, turned: `>` is closed, and a quarter turn opens it. */}
                    <ChevronRight
                        className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
                        aria-hidden
                    />
                </span>
            }
            tone="quiet"
            // A message that opens reads no excerpt: the header is the word alone.
            target={body === null ? summary : undefined}
            quote={quote}
            open={open}
            onToggle={() => setManual((was) => !(was ?? false))}
        >
            <Markdown id={`${id}-text`} className="text-muted-foreground">
                {body}
            </Markdown>
        </Row>
    );
}
