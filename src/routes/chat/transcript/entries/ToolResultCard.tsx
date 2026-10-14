import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "cn";
import { Hourglass } from "@/components";
import { Collapsible, CollapsibleTrigger } from "@/components/ui";
import type { NumberedLine } from "@/lib/text";
import { useMotion } from "@/hooks/use-motion";
import { CardBody } from "@/routes/chat/transcript/entries/CardBody";
import { ScrollPane } from "@/components";
import type { ToolNote, ToolPresentation, ToolStatus } from "@/routes/chat/transcript/tool-presentation";

export interface ToolResultCardProps {
    /** The entry this card draws, as the base of its ids. */
    id: string;
    /** The call and its result, already read into the shape a card shows. */
    presentation: ToolPresentation;
    /** Placement of this card, for a caller that gives it its own frame. */
    className?: string;
}

/**
 * How many lines a closed card shows, and from which end: a log is read from its
 * end (pi's shell card keeps the last lines), a file or a diff from its start.
 */
const CLOSED_LINES = { log: 5, file: 3, diff: 3, none: 0 } as const;

/**
 * One tool call and what it answered: a header, a body, and the line that opens the
 * whole of it. A diff or a file holds its numbers and marks still while the text
 * scrolls sideways.
 */
export function ToolResultCard({ id, presentation, className }: ToolResultCardProps) {
    const { title, detail, tone, status, body, notes } = presentation;
    const [open, setOpen] = useState(false);
    const [duration, setDuration] = useState<string | null>(null);
    const seen = useRef<{ id: string; startedAt: number | null; endedAt: number | null; running: boolean }>({
        id,
        startedAt: null,
        endedAt: null,
        running: false,
    });

    // Pi times a call from when its card first drew it running, so a replayed
    // transcript shows no duration; a settled card gets one write that freezes it.
    useEffect(() => {
        const restarted = id !== seen.current.id;
        if (restarted) seen.current = { id, startedAt: null, endedAt: null, running: false };
        const tick = () => {
            const clock = seen.current;
            const now = Date.now();
            if (status === "running") {
                clock.running = true;
                clock.startedAt ??= now;
                clock.endedAt = null;
                setDuration(`Elapsed ${formatDuration(now - clock.startedAt)}`);
                return;
            }
            if (!clock.running || clock.startedAt === null) return;
            clock.endedAt ??= now;
            setDuration(`Took ${formatDuration(clock.endedAt - clock.startedAt)}`);
        };
        const first = setTimeout(() => {
            // A card reused for another call must not show the clock of the call before.
            if (restarted) setDuration(null);
            tick();
        }, 0);
        if (status !== "running") return () => clearTimeout(first);
        const timer = setInterval(tick, 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [status, id]);

    const lines: Array<string | NumberedLine> = body.kind === "none" ? [] : body.lines;
    const closed = CLOSED_LINES[body.kind];
    const hidden = Math.max(0, lines.length - closed);
    const expandable = hidden > 0;
    // A log's arriving lines come above its end; a file's or a diff's below its start.
    const tail = body.kind === "log";
    const keptCount = Math.min(lines.length, closed);
    const kept = tail ? lines.slice(lines.length - keptCount) : lines.slice(0, keptCount);
    const rest = tail ? lines.slice(0, lines.length - keptCount) : lines.slice(keptCount);

    // The status mark is at the end of the header and is centered on the whole
    // of it, and it is for the calls of the model alone: a command the reader ran
    // carries its colour in the tool name instead (the design's colour axis), and a
    // failure of it is its `(exit N)` line.
    const header = (
        <>
            <span className="text-body-md min-w-0 flex-1 truncate">
                <span className={tone === "user-run" ? "text-user-run" : "text-primary-text"}>{title}</span>
                {detail !== null && detail !== "" && <span className="text-muted-foreground ml-3">{detail}</span>}
            </span>
            {duration !== null && <span className="text-label-md text-muted-foreground shrink-0">{duration}</span>}
            {tone === "model" && <StatusMark status={status} />}
        </>
    );

    return (
        <Collapsible
            id={id}
            open={open}
            onOpenChange={setOpen}
            className={cn("bg-card overflow-hidden rounded-md", className)}
        >
            {expandable ? (
                <CollapsibleTrigger
                    render={
                        <button
                            id={`${id}-header`}
                            className="mb-2 flex w-full items-center gap-2 px-3 pt-2 text-left"
                            aria-controls={`${id}-body`}
                        />
                    }
                >
                    {header}
                </CollapsibleTrigger>
            ) : (
                <div id={`${id}-header`} className="mb-2 flex items-center gap-2 px-3 pt-2">
                    {header}
                </div>
            )}
            {lines.length > 0 && (
                <div id={`${id}-body`} className={cn(body.kind === "log" && "mt-2 pb-2")}>
                    {body.kind === "log" ? (
                        <ScrollPane bars="horizontal" viewportClassName="px-3 pb-2">
                            <div className="text-code whitespace-pre">
                                {tail && <Arriving open={open} lines={rest as string[]} />}
                                {(kept as string[]).map((line, index) => (
                                    <div key={index}>{line}</div>
                                ))}
                                {!tail && <Arriving open={open} lines={rest as string[]} />}
                            </div>
                        </ScrollPane>
                    ) : (
                        <NumberedBody
                            id={id}
                            kept={kept as NumberedLine[]}
                            rest={rest as NumberedLine[]}
                            tail={tail}
                            open={open}
                        />
                    )}
                </div>
            )}
            {expandable && (
                <CollapsibleTrigger
                    render={
                        <button
                            id={`${id}-footer`}
                            aria-controls={`${id}-body`}
                            className="border-divider text-body-sm text-muted-foreground flex w-full items-center gap-2 border-t px-3 py-2 text-left"
                        />
                    }
                >
                    <span className="flex-1">{open ? "Collapse to hide" : `Expand to view ${hidden} more lines`}</span>
                    <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
                </CollapsibleTrigger>
            )}
            {notes.map((note, index) => (
                <p key={`${note.text}-${index}`} className={cn("text-body-md mt-2 px-3 pb-2", noteTone(note))}>
                    {note.text}
                </p>
            ))}
        </Collapsible>
    );
}

/** Where the call stands: a check, a cross, a turning hourglass, or a ring. */
function StatusMark({ status }: { status: ToolStatus }) {
    const { turn } = useMotion();

    if (status === "ok") return <Check className="text-success size-4 shrink-0" aria-label="Succeeded" />;
    if (status === "failed") return <X className="text-destructive size-4 shrink-0" aria-label="Failed" />;
    if (status === "running") {
        return (
            <motion.span className="text-primary-text flex shrink-0" {...turn}>
                <LoaderCircle className="size-4" aria-label="Running" />
            </motion.span>
        );
    }
    return (
        <span className="flex shrink-0">
            <Hourglass label="Waiting" />
        </span>
    );
}

/**
 * A numbered body: a diff, or a file (a diff without marks).
 *
 * Two columns, and only the second one scrolls: a line number that can leave the
 * screen with its line is of no use to a reader. A diff line carries the colour
 * of its mark as a background, painted by both columns so that it runs unbroken.
 *
 * The lines a card does not show yet are the same block in each column, on the
 * same transition, so that the two rows grow together.
 */
function NumberedBody({
    id,
    kept,
    rest,
    tail,
    open,
}: {
    id: string;
    kept: NumberedLine[];
    rest: NumberedLine[];
    tail: boolean;
    open: boolean;
}) {
    let digits = 1;
    for (const line of [...kept, ...rest]) digits = Math.max(digits, (line.number ?? "").length);

    const gutter = (lines: NumberedLine[]) =>
        lines.map((line, index) => (
            <div key={index} className={cn("flex gap-1 pr-2 pl-3", markRowTone(line.mark))}>
                <span className="text-muted-foreground/60 text-center" style={{ width: `${digits}ch` }}>
                    {line.number ?? ""}
                </span>
                <span className={cn("w-3 text-center", markTone(line.mark))}>
                    {line.mark.trim() === "" ? " " : line.mark}
                </span>
            </div>
        ));
    const texts = (lines: NumberedLine[]) =>
        lines.map((line, index) => (
            <div key={index} className={cn("min-w-full pr-3 whitespace-pre", markRowTone(line.mark))}>
                {line.text}
            </div>
        ));
    const arriving = (rows: (lines: NumberedLine[]) => ReactNode) => <CardBody open={open}>{rows(rest)}</CardBody>;

    return (
        <div className="text-code mt-2 flex pb-2 font-mono">
            <div id={`${id}-gutter`} className="shrink-0 select-none">
                {tail && arriving(gutter)}
                {gutter(kept)}
                {!tail && arriving(gutter)}
            </div>
            <ScrollPane id={`${id}-lines`} bars="horizontal" className="min-w-0 flex-1" viewportClassName="pb-2">
                {tail && arriving(texts)}
                {texts(kept)}
                {!tail && arriving(texts)}
            </ScrollPane>
        </div>
    );
}

function Arriving({ open, lines }: { open: boolean; lines: string[] }) {
    return (
        <CardBody open={open}>
            {lines.map((line, index) => (
                <div key={index}>{line}</div>
            ))}
        </CardBody>
    );
}

function markTone(mark: string): string {
    if (mark === "+") return "text-success";
    if (mark === "-") return "text-destructive";
    return "text-muted-foreground";
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${total % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function markRowTone(mark: string): string {
    if (mark === "+") return "bg-success/10";
    if (mark === "-") return "bg-destructive/10";
    return "";
}

function noteTone(note: ToolNote): string {
    if (note.tone === "warning") return "text-warning";
    if (note.tone === "error") return "text-destructive";
    return "text-muted-foreground";
}
