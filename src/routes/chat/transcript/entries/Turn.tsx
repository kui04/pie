import { ChevronRight, Layers, X } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Icon, Markdown } from "@/components";
import { Marker } from "@/components/ui";
import { BranchSummary } from "@/routes/chat/transcript/entries/BranchSummary";
import { CallRow } from "@/routes/chat/transcript/entries/CallRow";
import { Compaction } from "@/routes/chat/transcript/entries/Compaction";
import { CustomMessage } from "@/routes/chat/transcript/entries/CustomMessage";
import { Skill } from "@/routes/chat/transcript/entries/Skill";
import { ThoughtRow } from "@/routes/chat/transcript/entries/ThoughtRow";
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
                            className="min-h-10 w-full text-left hover:text-foreground sm:min-h-8.5"
                        />
                    }
                >
                    <Icon className="relative z-10 justify-start bg-surface" aria-hidden>
                        <Layers />
                    </Icon>
                    {/* Both text spans carry the same box; the truncating span also needs
                        the vertical padding as room for the ascenders `truncate` would clip. */}
                    <span className="py-0.5 text-body-md font-medium text-foreground trim">{heading.lead}</span>
                    <span className="min-w-0 truncate py-0.5 text-body-md trim">
                        {heading.files !== null && <span> · {heading.files}</span>}
                        {heading.failed !== null && <span className="text-destructive"> · {heading.failed}</span>}
                        {heading.calls !== null && <span className="hidden lg:inline"> · {heading.calls}</span>}
                    </span>
                    {facts.failed > 0 && (
                        <Icon className="shrink-0 text-destructive">
                            <X aria-hidden />
                        </Icon>
                    )}
                    {/* One icon, turned: `>` is closed, and a quarter turn opens it. */}
                    <Icon className="ml-auto shrink-0">
                        <ChevronRight className={cn("transition-transform", open && "rotate-90")} aria-hidden />
                    </Icon>
                </Marker>
            )}
            {(open || !folded) && (
                <div
                    id={folded ? `${id}-work` : undefined}
                    className={cn("flex min-w-0 flex-col", folded && "relative mt-1")}
                >
                    {/* The rail bisects the rows' glyphs, which are drawn over it on the
                        page's plane. A 1px box at the 16px glyph's 8px centre snaps to one
                        side at 1x, so the rail is a 2px line scaled to half its width about
                        the centre: it covers the half-pixel evenly and reads as one 1px line.
                        A turn that is not a fold has no rail: its single row's body carries
                        its own line instead, the way a quote does. */}
                    {folded && (
                        <span
                            aria-hidden
                            onClick={() => setManual(false)}
                            className="
                                absolute inset-y-0 left-2 z-0 flex w-3 -translate-x-1/2 cursor-pointer justify-center
                            "
                        >
                            <span className="h-full w-0.5 origin-center scale-x-50 bg-divider" />
                        </span>
                    )}
                    {hidden > 0 && (
                        <span className="py-1 pl-8 text-body-sm text-muted-foreground">+{hidden} more…</span>
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
                                    <Markdown id={item.id} className="py-1 text-muted-foreground">
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
                        if (item.kind === "compaction") {
                            return (
                                <Compaction
                                    key={item.id}
                                    id={item.id}
                                    tokensBefore={item.tokensBefore}
                                    body={item.body}
                                    quote={!folded}
                                />
                            );
                        }
                        if (item.kind === "branch_summary") {
                            return <BranchSummary key={item.id} id={item.id} body={item.body} quote={!folded} />;
                        }
                        if (item.kind === "skill") {
                            return (
                                <Skill
                                    key={item.id}
                                    id={item.id}
                                    summary={item.summary}
                                    body={item.body}
                                    quote={!folded}
                                />
                            );
                        }
                        if (item.kind === "custom_message") {
                            return (
                                <CustomMessage
                                    key={item.id}
                                    id={item.id}
                                    label={item.label}
                                    summary={item.summary}
                                    body={item.body}
                                    quote={!folded}
                                />
                            );
                        }
                        // A kind pi adds is a compile error here, never a row
                        // of the wrong family: the fold only builds the kinds
                        // above, so this is unreachable, not a fallback.
                        const unhandled: never = item;
                        return nothing(unhandled);
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
            {note !== null && <p className="mt-2 text-body-sm text-destructive">{note}</p>}
        </div>
    );
}

/** A kind nothing draws: nothing, rather than an object React cannot render. */
function nothing(item: never): null {
    void item;
    return null;
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
