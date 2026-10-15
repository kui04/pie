import { ChevronRight, Layers, X } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Markdown } from "@/components";
import { Marker, MarkerIcon } from "@/components/ui";
import { Notice } from "@/routes/chat/transcript/entries/Notice";
import { ThoughtRow } from "@/routes/chat/transcript/entries/ThoughtRow";
import { CallRow } from "@/routes/chat/transcript/entries/CallRow";
import { LIVE_ROWS, type WorkFacts, type WorkItem } from "@/routes/chat/transcript/fold";

export interface TurnProps {
    /** The turn this block draws, as the base of its ids. */
    id: string;
    /** What the folded heading counts. */
    facts: WorkFacts;
    /** What the work did, in the order it ran. */
    items: WorkItem[];
    /** The words the turn finished on, which stay outside the fold. */
    answer: { id: string; parts: { id: string; text: string }[] } | null;
    /** The one line of a turn that did not end cleanly. */
    note: string | null;
    /** Whether the run of this turn is still writing. */
    live: boolean;
}

/**
 * One turn's work, folded into a heading.
 *
 * The heading is the fold: `Worked for 2m 34s · 4 files`, counting up while the run is
 * live and frozen when it settles. What the work did stands behind a 1px rail, one line
 * each, and a live run keeps only its latest rows before it counts the rest. The answer
 * the turn finished on stands below the fold, never inside it.
 */
export function Turn({ id, facts, items, answer, note, live }: TurnProps) {
    // A run at work is read while it happens, and the fold closes itself once the answer of
    // the turn lands: that is what leaves a settled transcript as headings and answers, and it
    // is why a reader who returns to a node of the session finds its work where pi wrote it.
    // An explicit toggle by the reader outranks both.
    const [manual, setManual] = useState<boolean | null>(null);
    const open = manual ?? live;
    // A fold of one is a layer with nothing to fold: the row stands on its own, exactly as it
    // stands inside a fold. OpenHands draws the same line (`EVENT_GROUP_MIN_SIZE = 2`).
    const folded = items.length > 1;
    const shown = folded && live && items.length > LIVE_ROWS ? items.slice(items.length - LIVE_ROWS) : items;
    const hidden = items.length - shown.length;
    const heading = workedHeading(facts, live);

    return (
        <div className="flex min-w-0 flex-col">
            {folded && (
                <Marker
                    render={
                        <button
                            id={`${id}-heading`}
                            aria-controls={`${id}-work`}
                            aria-expanded={open}
                            onClick={() => setManual((was) => !(was ?? open))}
                            className="hover:text-foreground min-h-10 w-full text-left sm:min-h-[34px]"
                        />
                    }
                >
                    <MarkerIcon className="bg-surface relative z-10 flex size-6 items-center">
                        <Layers />
                    </MarkerIcon>
                    <span className="text-body-md text-foreground font-medium">{heading.lead}</span>
                    <span className="min-w-0 truncate">
                        {heading.files !== null && <span> · {heading.files}</span>}
                        {heading.failed !== null && <span className="text-destructive"> · {heading.failed}</span>}
                        {heading.calls !== null && <span className="hidden lg:inline"> · {heading.calls}</span>}
                    </span>
                    {facts.failed > 0 && <X className="text-destructive size-4 shrink-0" aria-hidden />}
                    {/* One icon, turned: `>` is closed, and a quarter turn opens it. */}
                    <ChevronRight
                        className={cn("ml-auto size-4 shrink-0 transition-transform", open && "rotate-90")}
                        aria-hidden
                    />
                </Marker>
            )}
            {(open || !folded) && (
                <div
                    id={folded ? `${id}-work` : undefined}
                    className={cn("flex min-w-0 flex-col", folded && "relative mt-1")}
                >
                    {/* The rail runs at the midpoint of the glyphs the rows lead with, and the
                        rows' own glyphs are drawn over it, on the page's plane.

                        It is 2px so that it can bisect a 16px glyph exactly. A glyph on an
                        integer coordinate has an integer centre (12px from the block's edge),
                        while a 1px line has its centre on a half pixel - a 1px line placed at 11.5
                        straddles two device pixels and reads as blurred and off centre, and one
                        snapped to 11 gives up the centring. An even width at an integer offset
                        (11..13) has its centre on 12 and is exact to the pixel. */}
                    {/* A fold's rail runs the whole of its work, and its centre bisects every glyph
                        in it. A turn that is not a fold has no such rail: a single row's body
                        carries its own line instead, the way a quote does. */}
                    {folded && (
                        <span
                            aria-hidden
                            onClick={() => setManual(false)}
                            className="absolute inset-y-0 left-2 z-0 flex w-3 -translate-x-1/2 cursor-pointer justify-center"
                        >
                            <span className="bg-divider h-full w-0.5" />
                        </span>
                    )}
                    {hidden > 0 && (
                        <span className="text-body-sm text-muted-foreground py-1 pl-8">+{hidden} more…</span>
                    )}
                    {shown.map((item) => {
                        if (item.kind === "call") {
                            return (
                                <CallRow
                                    key={item.id}
                                    id={item.id}
                                    tool={item.tool}
                                    presentation={item.presentation}
                                    quote={!folded}
                                />
                            );
                        }
                        if (item.kind === "text") {
                            return (
                                // Whatever words a turn holds are its work while they are inside it, so
                                // they stand past the rail with the rows' names - the words being
                                // written included, because the fold holds them the moment they are
                                // not the answer. The answer is the text the fold leaves out, and that
                                // keeps the block's own left edge.
                                <div key={item.id} className="pl-8">
                                    <Markdown id={item.id} className="text-muted-foreground py-1">
                                        {item.text}
                                    </Markdown>
                                </div>
                            );
                        }
                        if (item.kind === "thinking") {
                            return (
                                <ThoughtRow
                                    key={item.id}
                                    id={item.id}
                                    thinking={item.thinking}
                                    stillThinking={item.streaming}
                                    quote={!folded}
                                />
                            );
                        }
                        return (
                            <div key={item.row.id} className="pl-8">
                                <Notice
                                    id={item.row.id}
                                    label={item.row.label}
                                    summary={item.row.summary}
                                    body={item.row.body}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
            {answer !== null && (
                <div className="mt-2 flex min-w-0 flex-col gap-2">
                    {answer.parts.map((part) => (
                        <Markdown key={part.id} id={part.id}>
                            {part.text}
                        </Markdown>
                    ))}
                </div>
            )}
            {note !== null && <p className="text-body-sm text-destructive mt-2">{note}</p>}
        </div>
    );
}

interface Heading {
    /** What the turn did, and for how long. */
    lead: string;
    /** How many files it wrote, or null. */
    files: string | null;
    /** How many calls failed, or null. */
    failed: string | null;
    /** How many calls it made, which only a wide column shows. */
    calls: string | null;
}

/**
 * What a folded turn says: the time it took, then what it touched. A turn that only
 * thought says `Thought for 12s`, because that is the whole of what it did.
 */
function workedHeading(facts: WorkFacts, live: boolean): Heading {
    const spoken = facts.workedMs === null ? null : formatWorked(facts.workedMs);

    if (facts.calls === 0)
        return { lead: spoken === null ? "Thoughts" : `Thought for ${spoken}`, files: null, failed: null, calls: null };

    const lead = spoken === null ? (live ? "Working…" : "Worked") : `${live ? "Working" : "Worked"} for ${spoken}`;
    return {
        lead,
        files: facts.files === 0 ? null : facts.files === 1 ? "1 file" : `${facts.files} files`,
        failed: facts.failed === 0 ? null : facts.failed === 1 ? "1 failed" : `${facts.failed} failed`,
        calls: facts.calls === 1 ? "1 call" : `${facts.calls} calls`,
    };
}

function formatWorked(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
