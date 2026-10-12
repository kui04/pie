import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { cn } from "cn";
import { Button } from "@/components/ui";
import { ScrollPane } from "@/components";
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
 * A rough height of one row. Virtua measures every row it has drawn and corrects
 * this, so the number only has to be near enough for the first pass: too small
 * and the first screen holds too few rows, too large and it holds too many.
 */
const ROW = 88;

/** How close to the end counts as being at the end, in pixels. */
const NEAR = 24;

/**
 * The pill's jump runs, in pixels a millisecond. A jump over a long transcript is
 * not proportionally slower - the rows on the way have to be drawn for the
 * measurement to follow the scroll - so the speed is fixed and only the length
 * of the run grows with the distance, between these two bounds.
 */
const GLIDE_SPEED = 4;
const GLIDE_MIN_MS = 160;
const GLIDE_MAX_MS = 640;

/**
 * Whether the engine's reader asked for less motion. Asked here and not through
 * motion's hook because the answer is wanted once, where the pill is pressed, and
 * not as a value that re-renders the list.
 */
const wantsLessMotion = () =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The transcript, as a list that draws only what is on screen.
 *
 * A transcript grows without bound, so the list virtualizes it. The reader stays
 * where they were while rows arrive: the list follows the end only when the
 * reader was already there, which is what the pill under it is for otherwise.
 */
export function SessionTranscript({ rows, className, onRetractQueued }: SessionTranscriptProps) {
    const list = useRef<VirtualizerHandle>(null);
    // The element that scrolls, which is the scroll area's own viewport: virtua
    // only virtualizes the rows, and the jump has to reach this element itself.
    const viewport = useRef<HTMLDivElement>(null);
    const atEnd = useRef(true);
    // A jump of ours whose landing the sizes have not settled under yet, and the run
    // that is still carrying it there.
    const seeking = useRef(false);
    const gliding = useRef(false);
    const glide = useRef<number | undefined>(undefined);
    const resize = useRef<number | undefined>(undefined);
    const [away, setAway] = useState(false);
    const count = rows.length;

    /**
     * Send the list to its end, and remember that the end it lands on is only ever as
     * right as the sizes virtua knows. Virtua measures a row when it draws it, so the
     * height of a row drawn for the first time - or of one whose words rewrapped -
     * reaches its arithmetic only after that measurement.
     */
    const seekEnd = useCallback(() => {
        seeking.current = true;
        if (count > 0) list.current?.scrollToIndex(count - 1, { align: "end" });
    }, [count]);

    const stopGlide = useCallback(() => {
        if (glide.current !== undefined) cancelAnimationFrame(glide.current);
        glide.current = undefined;
        gliding.current = false;
    }, []);

    useEffect(
        () => () => {
            stopGlide();
            if (resize.current !== undefined) cancelAnimationFrame(resize.current);
        },
        [stopGlide],
    );

    // Follow the end while the reader is there: when the transcript changes (not only
    // when it grows - a tool result can be folded into a row that is already there,
    // and an appended entry can replace one) and when the band's height moves the foot
    // this list pads itself by, because both move the end.
    useEffect(() => {
        if (atEnd.current && !gliding.current) seekEnd();
    }, [rows, seekEnd]);

    const onScroll = (offset: number) => {
        const handle = list.current;
        if (!handle) return;
        // The end, as the reader left it. The sizes here are the ones of what is
        // on screen now, which is what makes this the place to read them: by the
        // time rows are added, the list is already a row longer.
        const end = offset + handle.viewportSize >= handle.scrollSize - NEAR;
        // A landing that stops short while a jump of ours is settling is ours, not
        // the reader leaving - and a measurement may have moved the end again. A
        // whole viewport short is the reader: the end is given up and the pill stands.
        // Neither reading is taken while a glide runs, because a glide starts a
        // whole transcript away from the end it is heading for.
        if (
            seeking.current &&
            !gliding.current &&
            (end || offset + handle.viewportSize < handle.scrollSize - handle.viewportSize)
        ) {
            seeking.current = false;
        }
        if (!seeking.current) atEnd.current = end;
        setAway(!end);
    };

    const toEnd = () => {
        const handle = list.current;
        atEnd.current = true;
        setAway(false);
        seeking.current = true;
        if (!handle || count === 0) return;
        const scroller = viewport.current;
        const from = scroller?.scrollTop ?? 0;
        const target = handle.scrollSize - handle.viewportSize;
        const distance = target - from;
        // A jump that is already there, a reader who asked for less motion, or a
        // scroller this code cannot reach: the library's own jump, at once.
        if (!scroller || wantsLessMotion() || distance <= NEAR) {
            seekEnd();
            return;
        }
        // A glide and not a cut, because of the rows on the way: virtua measures a row
        // only when it draws it, so a jump over the rows in between lands on their
        // estimated heights and leaves the tail wherever those estimates put it - the
        // reading the reader fixes by dragging the bar through the list once. Running
        // the scroll through them draws every one of them, and the end it arrives at
        // is the end it measured. How long the run takes is its length over the speed,
        // easing out onto the end.
        stopGlide();
        gliding.current = true;
        const duration = Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, distance / GLIDE_SPEED));
        let started: number | undefined;
        const step = (now: number) => {
            started ??= now;
            const t = Math.min(1, (now - started) / duration);
            const rest = 1 - t;
            const end = list.current ? list.current.scrollSize - list.current.viewportSize : target;
            scroller.scrollTop = from + (end - from) * (1 - rest * rest * rest);
            if (t < 1) {
                glide.current = requestAnimationFrame(step);
                return;
            }
            glide.current = undefined;
            gliding.current = false;
            seekEnd();
        };
        glide.current = requestAnimationFrame(step);
    };

    // The reader's own hand ends the jump: where they go next is theirs, and a row
    // that arrives afterwards must not drag them back to the end they asked for.
    const takeOver = () => {
        stopGlide();
        seeking.current = false;
    };

    return (
        <div
            className="relative flex min-h-0 flex-1 flex-col"
            // The reader's own hand ends the jump: where they go next is theirs.
            onWheel={takeOver}
            onTouchStart={takeOver}
        >
            <ScrollPane
                id="transcript-list"
                // The bar floats over the pane and fades in while the list moves: the
                // whole width stays with the words.
                viewportRef={viewport}
                viewportClassName="pt-2"
                className={cn("min-h-0 flex-1", className)}
            >
                <Virtualizer
                    ref={list}
                    data={rows}
                    itemSize={ROW}
                    scrollRef={viewport}
                    onScroll={onScroll}
                    // A glide can be stopped short by a row that grows while it runs,
                    // and the reader who asked for the end still has to get there.
                    onScrollEnd={() => {
                        if (seeking.current && !gliding.current) seekEnd();
                    }}
                    // Every height virtua learns moves the end, so a jump of ours is
                    // taken again until the sizes settle. This is what the library's
                    // own correction cannot be trusted to finish: it stops after a
                    // quiet spell and the browser may drop the notifications it was
                    // waiting for. The pin waits for the next frame because virtua
                    // calls this from its own ResizeObserver, and a scroll written
                    // inside an observer's delivery is the loop the browser reports
                    // as "undelivered notifications".
                    onResize={() => {
                        if (!atEnd.current || gliding.current || resize.current !== undefined) return;
                        resize.current = requestAnimationFrame(() => {
                            resize.current = undefined;
                            if (atEnd.current && !gliding.current) seekEnd();
                        });
                    }}
                >
                    {(row) => (
                        // Keyed by the row: virtua draws rows by position, and React
                        // would otherwise keep a card's state (an open body, a clock)
                        // with the next row that lands in that position. The row
                        // carries the content column, so it lines up with the composer
                        // band below it, and the air under it is what separates one
                        // entry from the next.
                        <div key={row.id} className="mx-auto w-full max-w-5xl px-4 pb-3">
                            <TranscriptEntry row={row} onRetractQueued={onRetractQueued} />
                        </div>
                    )}
                </Virtualizer>
            </ScrollPane>
            {away && (
                <Button
                    id="transcript-jump"
                    variant="ghost"
                    onClick={toEnd}
                    aria-label="To bottom"
                    // The design's key: a 32px circle at the list's end edge on a
                    // narrow screen, a pill with its label from `sm`, either one a
                    // step above that edge.
                    className={cn(
                        // Its own hover, not the variant's: the pill brings an opaque
                        // background, so its hover has to be one too (`surface-bright`,
                        // the plane the composer's keys hover on) - and one class, so
                        // nothing of the variant survives beside it.
                        "border-border bg-surface-container hover:bg-surface-bright text-foreground absolute right-2 bottom-2 size-8 rounded-full border p-0 shadow-md",
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
