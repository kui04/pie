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
    /**
     * The height of the composer band that covers the foot of this list, in pixels.
     * The list pads its scroll box by that much, and the key that jumps to the end
     * floats that much above the list's own edge, so nothing hides behind the card.
     */
    clearance: number;
    /** Placement of the scroller, for the pane that holds it. */
    className?: string;
    /** Passed to the retract of a queued row. */
    onRetractQueued?: () => void;
}

/**
 * A rough height of one row. Virtua measures every row it has drawn and corrects
 * this, so the number only has to be near enough for the first pass: too small
 * and the first screen holds too few rows, too large and it holds too many.
 */
const ROW = 88;

/** How close to the end counts as being at the end, in pixels. */
const NEAR = 24;

/** The gap the design keeps between the composer's band and everything that clears it. */
const BAND_GAP = 8;

/**
 * The transcript, as a list that draws only what is on screen.
 *
 * A transcript grows without bound, so the list virtualizes it. The reader stays
 * where they were while rows arrive: the list follows the end only when the
 * reader was already there, which is what the pill under it is for otherwise.
 */
export function TranscriptList({ rows, clearance, className, onRetractQueued }: TranscriptListProps) {
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
                // The composer band covers the foot of the pane; the box keeps room
                // for the whole of it, plus the gap the design leaves above the card
                // (`clearance` is the band's own height, measured by the pane).
                style={{ paddingBottom: clearance + BAND_GAP }}
                className={cn("min-h-0 flex-1 px-2 pt-2 min-[840px]:px-4", className)}
                id="transcript-list"
            >
                {(row) => (
                    // Keyed by the row: virtua draws rows by position, and React would
                    // otherwise keep a card's state (an open body, a clock) with the
                    // next row that lands in that position.
                    <div key={row.id} className="pb-2">
                        <EntryRenderer row={row} onRetractQueued={onRetractQueued} />
                    </div>
                )}
            </VList>
            {away && (
                <Button
                    id="transcript-jump"
                    variant="ghost"
                    onClick={toEnd}
                    aria-label="To bottom"
                    // The design's key: a 32px circle at the band's end edge on a
                    // narrow screen, a pill with its label from 600px, either one a
                    // gap above the card because the band's height is what it clears.
                    style={{ bottom: clearance + BAND_GAP }}
                    className={cn(
                        "border-border bg-surface-container hover:bg-surface-container-high text-foreground absolute right-2 size-8 rounded-full border p-0 shadow-md",
                        "min-[600px]:right-auto min-[600px]:left-1/2 min-[600px]:h-auto min-[600px]:w-max min-[600px]:-translate-x-1/2",
                        "min-[600px]:gap-2 min-[600px]:rounded-xl min-[600px]:px-3 min-[600px]:py-2",
                    )}
                >
                    <ArrowDown className="text-muted-foreground size-4" />
                    <span className="text-body-md hidden min-[600px]:block">To bottom</span>
                </Button>
            )}
        </div>
    );
}
