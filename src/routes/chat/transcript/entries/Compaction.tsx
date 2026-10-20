import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Icon, Markdown } from "@/components";
import { Marker } from "@/components/ui";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { compactionGlyph } from "@/routes/chat/transcript/entries/tool-glyph";

export interface CompactionProps {
    /** The entry this row draws, as the base of its ids. */
    id: string;
    /** Context size the compaction cut from, for the header line. */
    tokensBefore: number;
    /** The whole summary: the header never excerpts it, the body opens it. */
    body: string;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/**
 * What a compaction left behind: the word and the size it cut from on the row,
 * the summary behind it. The header carries no line of the summary - pi's own
 * transcript reads the same row as a word and an expander - so a reader finds
 * where the context was cut and opens what it kept.
 */
export function Compaction({ id, tokensBefore, body, quote = false }: CompactionProps) {
    // A compaction is read closed; the reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const open = manual ?? false;

    if (body === "") {
        return (
            <Marker id={id} className="min-h-10 w-full pr-1 sm:min-h-8.5">
                <Icon className="relative z-10 justify-start bg-surface" aria-hidden>
                    {compactionGlyph()}
                </Icon>
                <span className="shrink-0 text-body-md font-medium whitespace-nowrap text-violet trim">Compaction</span>
            </Marker>
        );
    }

    return (
        <Row
            id={id}
            glyph={compactionGlyph()}
            name={
                // The chevron stands with the word, not at the row's end: a compaction sits beside
                // collapsed work often enough that "this is a notice, and it opens" has to be
                // readable from the word itself.
                <span className="flex items-center gap-2">
                    <span className="font-medium text-violet trim">Compaction</span>
                    {/* One icon, turned: `>` is closed, and a quarter turn opens it. */}
                    <Icon>
                        <ChevronRight className={cn("transition-transform", open && "rotate-90")} aria-hidden />
                    </Icon>
                </span>
            }
            tone="quiet"
            target={`Compacted from ${tokensBefore.toLocaleString("en-US")} tokens`}
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
