import { useMemo, useRef } from "react";
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
import { Turn } from "@/routes/chat/transcript/entries/Turn";
import { foldTurns } from "@/routes/chat/transcript/fold";

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
    // One turn's work is one block: the rows are folded before virtua sees them, so a
    // long session draws headings and answers rather than a card per call. The run is
    // at work on its own last turn, which is the one the line under the list names.
    const slots = useMemo(() => foldTurns(rows), [rows]);
    const lastWork = slots.reduce((found, slot, index) => (slot.kind === "work" ? index : found), -1);

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
                        {/* Headroom for the floating bar above, four lines of
                            legroom above the fade's dense end below. */}
                        <div className="mx-auto w-full max-w-5xl px-4 pt-16 pb-20">
                            <Virtualizer data={slots} bufferSize={AHEAD} scrollRef={viewport}>
                                {(slot, index) => (
                                    // Keyed by the row or the turn: virtua draws by position, and
                                    // React would otherwise keep a fold's state (an open body, a
                                    // rail, a clock) with the next slot that lands there.
                                    <div key={slot.key} className="w-full pb-3">
                                        {slot.kind === "work" ? (
                                            <Turn
                                                id={slot.key}
                                                facts={slot.facts}
                                                items={slot.items}
                                                answer={slot.answer}
                                                note={slot.note}
                                                live={slot.live || (working && index === lastWork)}
                                            />
                                        ) : (
                                            <TranscriptEntry row={slot.row} onRetractQueued={onRetractQueued} />
                                        )}
                                    </div>
                                )}
                            </Virtualizer>
                        </div>
                    </MessageScrollerContent>
                </ScrollPane>
                {/* The fades the rows scroll under: the page's own plane, each
                    gradient to transparent one content column wide, so the
                    scrollbar lane stays clear. The bar sits on a solid backing;
                    one line of fade below it, two lines above the composer. */}
                <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10">
                    <div className="bg-surface h-11" />
                    <div className="mx-auto w-full max-w-5xl px-4">
                        <div className="from-surface to-surface/0 h-5 bg-linear-to-b" />
                    </div>
                </div>
                <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10">
                    <div className="from-surface to-surface/0 mx-auto size-full max-w-5xl bg-linear-to-t px-4" />
                </div>
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
                        // Above both fades, so the gradient never covers it.
                        "z-20 h-auto gap-2 rounded-xl px-3 py-2 data-[direction=end]:bottom-2",
                    )}
                >
                    <ArrowDown className="text-muted-foreground size-4" />
                    <span className="text-body-md">To bottom</span>
                </MessageScrollerButton>
            </MessageScroller>
        </MessageScrollerProvider>
    );
}
