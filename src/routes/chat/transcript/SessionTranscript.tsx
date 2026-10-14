import { useRef } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "cn";
import { Virtualizer } from "virtua";
import { ScrollPane } from "@/components";
import {
    MessageScroller,
    MessageScrollerButton,
    MessageScrollerContent,
    MessageScrollerProvider,
    MessageScrollerViewport,
} from "@/components/ui";
import type { TranscriptRow } from "@/lib/transcript";
import { TranscriptEntry } from "@/routes/chat/transcript/TranscriptEntry";

export interface SessionTranscriptProps {
    /** The transcript, as the store and the fold read it. */
    rows: TranscriptRow[];
    /** Whether a run of this session is in flight, and the region is still being written. */
    working?: boolean;
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
 * A transcript grows without bound, so virtua draws it, and no row here is a
 * `MessageScrollerItem`: the primitive anchors the rows it is handed by their place among
 * the children of the content, and a virtualized list has no such place. The region that
 * scrolls, the following of its end and the way back are `message-scroller`'s, and the bar
 * over it is `ScrollPane`'s.
 */
export function SessionTranscript({ rows, working = false, className, onRetractQueued }: SessionTranscriptProps) {
    const viewport = useRef<HTMLDivElement>(null);

    return (
        <MessageScrollerProvider autoScroll>
            <MessageScroller id="transcript-list" className={cn("min-h-0 flex-1", className)}>
                <ScrollPane
                    className="min-h-0 w-full flex-1 rounded-b-lg"
                    // The scroller's own viewport, so that the element that scrolls is the one
                    // virtua measures. Its anchor is off because virtua moves the list itself,
                    // and two answers to one shift are a fight.
                    viewport={<MessageScrollerViewport ref={viewport} className="pt-2 [overflow-anchor:none]" />}
                >
                    {/* A run in flight is a region still being written: `aria-busy` holds the
                        log's additions until it settles, or a screen reader would read an
                        answer that is still growing, and read it again once it is whole. */}
                    <MessageScrollerContent aria-busy={working || undefined}>
                        <div className="mx-auto w-full max-w-5xl px-4">
                            <Virtualizer data={rows} bufferSize={AHEAD} scrollRef={viewport}>
                                {(row) => (
                                    // Keyed by the row: virtua draws by position, and React would
                                    // otherwise keep a card's state (an open body, a clock) with the
                                    // next row that lands there.
                                    <div key={row.id} className="w-full pb-3">
                                        <TranscriptEntry row={row} onRetractQueued={onRetractQueued} />
                                    </div>
                                )}
                            </Virtualizer>
                        </div>
                    </MessageScrollerContent>
                </ScrollPane>
                <MessageScrollerButton
                    id="transcript-jump"
                    variant="ghost"
                    size="sm"
                    aria-label="To bottom"
                    // One control at every width, a pill that says what it does. `border-0` is
                    // not tidying: a button's transparent 1px border would clip the hairline of
                    // `elevation-raised` into a second edge beside it. Both hovers are written
                    // out, because the variant's own dark hover is `muted` at half alpha and
                    // outranks a plain `hover:`. The registry's own height and placement are
                    // answered in the variants it wrote them in.
                    className={cn(
                        "elevation-raised bg-surface-container hover:bg-surface-bright",
                        "dark:hover:bg-surface-bright text-foreground border-0",
                        "h-auto gap-2 rounded-xl px-3 py-2 data-[direction=end]:bottom-2",
                    )}
                >
                    <ArrowDown className="text-muted-foreground size-4" />
                    <span className="text-body-md">To bottom</span>
                </MessageScrollerButton>
            </MessageScroller>
        </MessageScrollerProvider>
    );
}
