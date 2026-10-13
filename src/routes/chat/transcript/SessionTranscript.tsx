import { ArrowDown } from "lucide-react";
import { Virtualizer } from "virtua";
import { cn } from "cn";
import { Button } from "@/components/ui";
import { ScrollPane } from "@/components";
import { useFollowEnd } from "@/hooks/use-follow-end";
import type { TranscriptRow } from "@/lib/transcript";
import { TranscriptEntry } from "@/routes/chat/transcript/TranscriptEntry";

export interface SessionTranscriptProps {
    /** The transcript, as the store and the fold read it. */
    rows: TranscriptRow[];
    /** Placement of the scroller, for the pane that holds it. */
    className?: string;
    /** Passed to the retract of a queued row. */
    onRetractQueued?: () => void;
}

/**
 * How much of the list beyond the viewport is drawn, in pixels: virtua's
 * `bufferSize`, which its own note raises "to avoid showing blank items in fast
 * scrolling". Its default of 200 is about one of these rows.
 */
const AHEAD = 800;

/**
 * The transcript, as a list that draws only what is on screen.
 *
 * A transcript grows without bound, so the list virtualizes it. The reader stays where they
 * were while rows arrive: the list follows its end only while they are there, and the pill
 * under it is the way back for when they are not - the rule itself is `useFollowEnd`'s.
 */
export function SessionTranscript({ rows, className, onRetractQueued }: SessionTranscriptProps) {
    const { list, viewport, away, toEnd, onScroll, onResize, onScrollEnd, onWheel, onTouchStart, onTouchMove } =
        useFollowEnd(rows);

    return (
        <div
            className="relative flex min-h-0 flex-1 flex-col"
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
        >
            <ScrollPane
                id="transcript-list"
                // The bar floats over the pane and fades in while the list moves: the
                // whole width stays with the words.
                viewportRef={viewport}
                viewportClassName="pt-2 [overflow-anchor:none]"
                // The scroll area is the pane, not the content column: the bar Radix draws
                // belongs to the region it scrolls, so a column-sized one puts the bar out
                // in the middle of a wide window. The column is inside it instead.
                className={cn("min-h-0 w-full flex-1 rounded-b-lg", className)}
            >
                <div className="mx-auto w-full max-w-5xl px-4">
                    <Virtualizer
                        ref={list}
                        data={rows}
                        bufferSize={AHEAD}
                        scrollRef={viewport}
                        onScroll={onScroll}
                        onScrollEnd={onScrollEnd}
                        onResize={onResize}
                    >
                        {(row) => (
                            // Keyed by the row: virtua draws rows by position, and React
                            // would otherwise keep a card's state (an open body, a clock)
                            // with the next row that lands in that position. The scroller
                            // carries the content column, so a row is the entry and the air
                            // under it, and the air is what separates one entry from the next.
                            <div key={row.id} className="w-full pb-3">
                                <TranscriptEntry row={row} onRetractQueued={onRetractQueued} />
                            </div>
                        )}
                    </Virtualizer>
                </div>
            </ScrollPane>
            {away && (
                <Button
                    id="transcript-jump"
                    variant="ghost"
                    onClick={toEnd}
                    aria-label="To bottom"
                    // The design's key: a 32px circle at the list's end edge on a
                    // narrow screen, a pill with its label from `sm`, either one a
                    // step above that edge. `border-0` is not tidying: a button brings
                    // a transparent 1px border and clips its fill to the padding box,
                    // so that ring would show the page through it and the hairline of
                    // `elevation-raised` would read as a second edge beside it.
                    className={cn(
                        // Its own hover, not the variant's: the pill brings an opaque
                        // background, while the variant's dark hover is `muted` at half
                        // alpha - translucent, and it outranks a plain `hover:` class -
                        // so both are written out (`surface-bright`, the plane the
                        // composer's keys hover on).
                        "elevation-raised bg-surface-container hover:bg-surface-bright",
                        "dark:hover:bg-surface-bright text-foreground absolute right-2 bottom-2",
                        "size-8 rounded-full border-0 p-0",
                        "sm:right-auto sm:left-1/2 sm:h-auto sm:w-max sm:-translate-x-1/2",
                        "sm:gap-2 sm:rounded-xl sm:px-3 sm:py-2",
                    )}
                >
                    <ArrowDown className="text-muted-foreground size-4" />
                    <span className="text-body-md hidden sm:block">To bottom</span>
                </Button>
            )}
        </div>
    );
}
