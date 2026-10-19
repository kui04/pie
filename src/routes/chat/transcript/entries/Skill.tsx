import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Markdown } from "@/components";
import { Marker, MarkerIcon } from "@/components/ui";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { skillGlyph } from "@/routes/chat/transcript/entries/tool-glyph";

export interface SkillProps {
    /** The entry this row draws, as the base of its ids. */
    id: string;
    /**
     * The whole content when it is one line, else nothing: the header of a
     * longer skill is the word alone, never the first line of its body.
     */
    summary: string;
    /** The whole of it, when that is more than the one line. */
    body: string | null;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/**
 * What a skill run left behind: the word alone when it opens, the whole
 * content when it fits on one line. A skill of one line has nothing to open,
 * so it is not a button.
 */
export function Skill({ id, summary, body, quote = false }: SkillProps) {
    // A skill is read closed; the reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const open = manual ?? false;

    if (body === null) {
        return (
            <Marker id={id} className="min-h-10 w-full pr-1 sm:min-h-[34px]">
                <MarkerIcon className="relative z-10 flex size-6 items-center bg-surface">{skillGlyph()}</MarkerIcon>
                <span className="shrink-0 text-body-md font-medium whitespace-nowrap text-violet trim">Skill</span>
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
            glyph={skillGlyph()}
            name={
                <span className="flex items-center gap-2">
                    <span className="font-medium text-violet trim">Skill</span>
                    {/* One icon, turned: `>` is closed, and a quarter turn opens it. */}
                    <ChevronRight
                        className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
                        aria-hidden
                    />
                </span>
            }
            tone="quiet"
            // A skill that opens reads no excerpt: the header is the word alone.
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
