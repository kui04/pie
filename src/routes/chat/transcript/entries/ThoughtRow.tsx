import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Icon, Markdown, ScrollPane } from "@/components";
import { useFollowTail } from "@/hooks/useFollowTail";
import { useMotion } from "@/hooks/useMotion";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { thoughtGlyph } from "@/routes/chat/transcript/entries/ToolGlyph";

export interface ThoughtRowProps {
    /** The entry this row draws, as the base of its ids. */
    id: string;
    /** The reasoning, as the model wrote it. */
    thinking: string;
    /** Whether the model is still writing it. */
    stillThinking?: boolean;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/** How tall the window of a thought is while it arrives: about a dozen of its lines. */
const WINDOW = "max-h-25";

/** How tall the same thought may be once a reader opens it later. */
const OPENED = "max-h-[46vh]";

/**
 * What the model reasoned before it acted, as one row of its own.
 *
 * A thought is an entry of the session, so it is a row and never a count: a reader who comes
 * back to it must find it where pi wrote it. While it arrives the word is `Thinking…` in the
 * marker's shimmer, its body is read through a window that keeps its newest line in view, and it
 * closes itself when the model stops thinking. Nothing previews it, and it wears no frame.
 */
export function ThoughtRow({ id, thinking, stillThinking = false, quote = false }: ThoughtRowProps) {
    // A thought being written is read while it arrives, and folds itself away once it is
    // written: the reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const open = manual ?? stillThinking;
    const { still } = useMotion();
    const tail = useFollowTail(stillThinking, still);

    return (
        <Row
            id={id}
            glyph={thoughtGlyph()}
            name={
                stillThinking ? (
                    <span className="shimmer font-medium trim" role="status">
                        Thinking…
                    </span>
                ) : (
                    <span className="trim">Thoughts</span>
                )
            }
            end={
                <Icon>
                    <ChevronRight className={cn("transition-transform", open && "rotate-90")} aria-hidden />
                </Icon>
            }
            tone="quiet"
            quote={quote}
            open={open}
            onToggle={() => setManual((was) => !(was ?? stillThinking))}
        >
            <ScrollPane
                className="min-w-0"
                viewportRef={tail}
                viewportClassName={cn("live-window pr-2", stillThinking ? WINDOW : OPENED)}
            >
                <Markdown id={`${id}-reasoning`} className="text-muted-foreground">
                    {thinking}
                </Markdown>
            </ScrollPane>
        </Row>
    );
}
