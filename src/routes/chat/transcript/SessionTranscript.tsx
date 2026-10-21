import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "cn";
import { Virtualizer } from "virtua";
import { ScrollPane, Icon } from "@/components";
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
    /**
     * The visual viewport's height while the composer owns the keyboard. A change keeps
     * the end in view when the reader was following it, because the keyboard shrinks the
     * region without changing the rows.
     */
    viewportHeight?: number;
}

/**
 * How much of the list beyond the viewport is drawn, in pixels: virtua's
 * `bufferSize`, which its own note raises "to avoid showing blank items in fast
 * scrolling". A live turn can be taller than the viewport, so two screens of
 * history stay mounted above it; the list still virtualizes long sessions.
 */
const AHEAD = 2400;

/**
 * The transcript, as a list that draws only what is on screen.
 *
 * A transcript grows without bound, so virtua draws it, and no row here is a
 * `MessageScrollerItem`: the primitive anchors the rows it is handed by their place among
 * the children of the content, and a virtualized list has no such place. The region that
 * scrolls, the following of its end and the way back are `message-scroller`'s, and the bar
 * over it is `ScrollPane`'s.
 */
export function SessionTranscript({
    rows,
    working = false,
    className,
    onRetractQueued,
    viewportHeight,
}: SessionTranscriptProps) {
    const viewport = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    const lastScroll = useRef(0);
    // One turn's work is one block: the rows are folded before virtua sees them, so a
    // long session draws headings and answers rather than a card per call. The run is
    // at work on its own last turn, which is the one the line under the list names.
    const slots = useMemo(() => foldTurns(rows), [rows]);
    const lastWork = slots.reduce((found, slot, index) => (slot.kind === "work" ? index : found), -1);
    // While a run writes, keep the settled turns mounted: the growing live turn makes
    // Virtua drop the rest of its window, and the reader loses the history above it.
    const keepMounted = useMemo(() => (working ? slots.map((_, index) => index) : undefined), [working, slots]);

    // Virtua remeasures while a live turn grows. Keep the reader's place if they
    // have left the end, and keep the end in view while they are following it.
    useEffect(() => {
        const element = viewport.current;
        if (element === null) return;
        const atEnd = () => element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
        let touched = 0;
        const onScroll = () => {
            lastScroll.current = element.scrollTop;
            // Content growth while following the end must not take the lock away.
            if (atEnd()) follow.current = true;
        };
        const onWheel = (event: WheelEvent) => {
            if (event.deltaY < 0) follow.current = false;
            else if (atEnd()) follow.current = true;
        };
        const onTouchStart = () => {
            touched = element.scrollTop;
        };
        const onTouchMove = () => {
            if (element.scrollTop < touched) follow.current = false;
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") follow.current = false;
            else if (event.key === "End") follow.current = true;
        };
        element.addEventListener("scroll", onScroll, { passive: true });
        element.addEventListener("wheel", onWheel, { passive: true });
        element.addEventListener("touchstart", onTouchStart, { passive: true });
        element.addEventListener("touchmove", onTouchMove, { passive: true });
        element.addEventListener("keydown", onKeyDown);
        onScroll();
        return () => {
            element.removeEventListener("scroll", onScroll);
            element.removeEventListener("wheel", onWheel);
            element.removeEventListener("touchstart", onTouchStart);
            element.removeEventListener("touchmove", onTouchMove);
            element.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    useLayoutEffect(() => {
        const element = viewport.current;
        if (element === null) return;
        if (follow.current) element.scrollTop = element.scrollHeight;
        else element.scrollTop = lastScroll.current;
        const frame = requestAnimationFrame(() => {
            if (viewport.current !== element) return;
            element.scrollTop = follow.current ? element.scrollHeight : lastScroll.current;
        });
        return () => cancelAnimationFrame(frame);
    }, [rows, viewportHeight]);

    return (
        <MessageScrollerProvider autoScroll={false}>
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
                        {/* Headroom for the bar above and the fade below it; four
                            lines of legroom above the composer's fade. */}
                        <div className="mx-auto w-full max-w-5xl px-4 pt-5 pb-20">
                            <Virtualizer data={slots} bufferSize={AHEAD} keepMounted={keepMounted} scrollRef={viewport}>
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
                <MessageScrollerButton
                    id="transcript-jump"
                    variant="ghost"
                    size="sm"
                    aria-label="To bottom"
                    // One control at every width, a pill that says what it does. It is flat
                    // like the composer: a card with the same hairline, and no shadow. Both
                    // hovers keep the card fill, because the variant's own dark hover is `muted`
                    // at half alpha and outranks a plain `hover:`. The registry's own height
                    // and placement are answered in the variants it wrote them in.
                    className="
                        z-30 h-auto cursor-pointer gap-2 rounded-xl border border-foreground/10 bg-card px-3 py-2
                        text-foreground
                        hover:bg-card
                        data-[direction=end]:bottom-2
                        dark:hover:bg-card
                    "
                >
                    <Icon className="text-muted-foreground">
                        <ArrowDown />
                    </Icon>
                    <span className="text-body-md">To bottom</span>
                </MessageScrollerButton>
            </MessageScroller>
        </MessageScrollerProvider>
    );
}
