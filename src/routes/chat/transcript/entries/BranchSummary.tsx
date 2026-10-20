import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Icon, Markdown } from "@/components";
import { Marker } from "@/components/ui";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { branchGlyph } from "@/routes/chat/transcript/entries/ToolGlyph";

export interface BranchSummaryProps {
    /** The entry this row draws, as the base of its ids. */
    id: string;
    /** The whole summary, as with a compaction. */
    body: string;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/**
 * The summary of a branch the session left: the word alone on its row, the
 * summary behind it, read exactly like a compaction.
 */
export function BranchSummary({ id, body, quote = false }: BranchSummaryProps) {
    // A summary is read closed; the reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const open = manual ?? false;

    if (body === "") {
        return (
            <Marker id={id} className="min-h-10 w-full pr-1 sm:min-h-8.5">
                <Icon className="relative z-10 justify-start bg-surface" aria-hidden>
                    {branchGlyph()}
                </Icon>
                <span className="shrink-0 text-body-md font-medium whitespace-nowrap text-violet trim">Summary</span>
            </Marker>
        );
    }

    return (
        <Row
            id={id}
            glyph={branchGlyph()}
            name={
                <span className="flex items-center gap-2">
                    <span className="font-medium text-violet trim">Summary</span>
                    {/* One icon, turned: `>` is closed, and a quarter turn opens it. */}
                    <Icon>
                        <ChevronRight className={cn("transition-transform", open && "rotate-90")} aria-hidden />
                    </Icon>
                </span>
            }
            tone="quiet"
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
