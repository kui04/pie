import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { TranscriptRow } from "@/lib/transcript";
import { EntryRenderer } from "@/routes/chat/components/EntryRenderer";

export interface TranscriptListProps {
    /** The transcript, as the store and the fold read it. */
    rows: TranscriptRow[];
}

/**
 * A rough height of one row. Virtua measures every row it has drawn and corrects
 * this, so the number only has to be near enough for the first pass: too small
 * and the first screen holds too few rows, too large and it holds too many.
 */
const ROW = 88;

/** How close to the end counts as being at the end, in pixels. */
const NEAR = 24;

/**
 * The transcript, as a list that draws only what is on screen.
 *
 * A transcript grows without bound, so the list virtualizes it. The reader stays
 * where they were while rows arrive: the list follows the end only when the
 * reader was already there, which is what the pill under it is for otherwise.
 */
export function TranscriptList({ rows }: TranscriptListProps) {
    const list = useRef<VListHandle>(null);
    const atEnd = useRef(true);
    const [away, setAway] = useState(false);
    const count = rows.length;

    // Follow the end when the transcript changes, not when it grows: a tool result
    // can be folded into a row that is already there, and an appended entry can
    // replace one, and both leave the count as it was.
    useEffect(() => {
        if (atEnd.current && count > 0) list.current?.scrollToIndex(count - 1, { align: "end" });
    }, [rows, count]);

    const onScroll = (offset: number) => {
        const handle = list.current;
        if (!handle) return;
        // The end, as the reader left it. The sizes here are the ones of what is
        // on screen now, which is what makes this the place to read them: by the
        // time rows are added, the list is already a row longer.
        const end = offset + handle.viewportSize >= handle.scrollSize - NEAR;
        atEnd.current = end;
        setAway(!end);
    };

    const toEnd = () => {
        atEnd.current = true;
        setAway(false);
        if (count > 0) list.current?.scrollToIndex(count - 1, { align: "end" });
    };

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <VList
                ref={list}
                data={rows}
                itemSize={ROW}
                onScroll={onScroll}
                className="min-h-0 flex-1 px-3"
                id="transcript-list"
            >
                {(row) => (
                    // Keyed by the row: virtua draws rows by position, and React would
                    // otherwise keep a card's state (an open body, a clock) with the
                    // next row that lands in that position.
                    <div key={row.id} className="pb-3">
                        <EntryRenderer row={row} />
                    </div>
                )}
            </VList>
            {away && (
                <Button
                    id="transcript-jump"
                    variant="secondary"
                    size="sm"
                    onClick={toEnd}
                    aria-label="Jump to the latest"
                    className={cn(
                        "border-border absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border shadow-md",
                    )}
                >
                    <ArrowDown className="size-4" />
                    <span className="hidden sm:inline">Latest</span>
                </Button>
            )}
        </div>
    );
}
