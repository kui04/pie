import { LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "cn";
import { ScrollPane } from "@/components";
import { useFollowTail } from "@/hooks/use-follow-tail";
import { useMotion } from "@/hooks/use-motion";
import type { NumberedLine } from "@/lib/text";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { glyphFor, toolLabel } from "@/routes/chat/transcript/entries/tool-glyph";
import type { ToolBody, ToolNote, ToolPresentation, ToolStatus } from "@/routes/chat/transcript/presentation";

export interface CallRowProps {
    /** The call this row draws, as the base of its ids. */
    id: string;
    /** The tool it called, for the glyph at the head of the row. */
    tool: string;
    /** The call and its result, already read into the shape a row shows. */
    presentation: ToolPresentation;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/** The height an open body may take before it scrolls inside itself. */
const BODY_MAX = "max-h-[46vh]";

/**
 * The window of a body that is still arriving: five lines, and then it scrolls - the newest line
 * stays in view, the ends of the box shade where more waits behind them, and the transcript is
 * spared a body that grows without end.
 */
const LIVE_WINDOW = "max-h-25";

/**
 * One call, as a single row: the glyph of its kind, its name, what it aimed at, and the clock it
 * kept. The whole of what it produced waits behind the row - nothing is previewed - and it
 * arrives flat, at the row's own text column, under no frame of its own.
 */
export function CallRow({ id, tool, presentation, quote = false }: CallRowProps) {
    // A call that runs is read while it runs, and folds itself away once it settles: the
    // reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const { title, detail, tone, status, body, notes } = presentation;
    const open = manual ?? status === "running";
    const clock = useCallClock(id, status, presentation.durationMs);
    const lines = body.kind === "none" ? [] : body.lines;
    // A command the reader ran leads with its prompt; a call the model made leads with the name
    // of the tool, spelled as a name rather than as pi's identifier for it.
    const name = tone === "user-run" ? title : toolLabel(tool);
    const end =
        status === "running" || status === "failed" || clock !== null ? (
            <>
                {status === "running" ? <Running /> : clock !== null && <Clock text={clock} />}
                {status === "failed" && <X className="text-destructive size-4" aria-label="Failed" />}
            </>
        ) : undefined;

    return (
        <Row
            id={id}
            glyph={glyphFor(tool)}
            name={name}
            tone={tone}
            target={detail}
            end={end}
            quote={quote}
            open={open}
            onToggle={() => setManual((was) => !(was ?? status === "running"))}
        >
            {lines.length > 0 && <Body id={id} body={body} live={status === "running"} />}
            {notes.map((note, index) => (
                <p key={`${note.text}-${index}`} className={cn("text-body-sm", noteTone(note))}>
                    {note.text}
                </p>
            ))}
        </Row>
    );
}

function Clock({ text }: { text: string }) {
    return <span className="text-label-md tabular-nums">{text}</span>;
}

function Running() {
    const { turn } = useMotion();
    return (
        <motion.span className="text-primary-text flex shrink-0" {...turn}>
            <LoaderCircle className="size-4" aria-label="Running" />
        </motion.span>
    );
}

/** The whole of what a call produced: a log, or a file or a diff with its own gutter. */
function Body({ id, body, live }: { id: string; body: ToolBody; live: boolean }) {
    if (body.kind === "log") return <LogBody lines={body.lines} live={live} />;
    if (body.kind === "none") return null;
    return <NumberedBody id={id} lines={body.lines} />;
}

function LogBody({ lines, live }: { lines: string[]; live: boolean }) {
    const { still } = useMotion();
    const tail = useFollowTail(live, still);

    return (
        <ScrollPane
            bars="both"
            className="min-w-0"
            viewportRef={tail}
            viewportClassName={cn("live-window", live ? LIVE_WINDOW : BODY_MAX, "pr-2")}
        >
            <div className="text-code whitespace-pre">
                {lines.map((line, index) => (
                    <div key={index}>{line}</div>
                ))}
            </div>
        </ScrollPane>
    );
}

/**
 * A diff, or a file (a diff without marks): two columns, and only the second one scrolls
 * sideways, because a line number that can leave the screen with its line is of no use to a
 * reader. A diff line carries the colour of its mark as a background, painted by both columns
 * so that it runs unbroken.
 */
function NumberedBody({ id, lines }: { id: string; lines: NumberedLine[] }) {
    let digits = 1;
    for (const line of lines) digits = Math.max(digits, (line.number ?? "").length);

    return (
        <div className={cn("text-code flex min-w-0 overflow-y-auto font-mono", BODY_MAX)}>
            <div className="shrink-0 select-none">
                {lines.map((line, index) => (
                    <div key={index} className={cn("flex gap-1 pr-2", markRowTone(line.mark))}>
                        <span className="text-muted-foreground/60 text-center" style={{ width: `${digits}ch` }}>
                            {line.number ?? ""}
                        </span>
                        <span className={cn("w-3 text-center", markTone(line.mark))}>
                            {line.mark.trim() === "" ? " " : line.mark}
                        </span>
                    </div>
                ))}
            </div>
            <ScrollPane id={`${id}-lines`} bars="horizontal" className="min-w-0 flex-1" viewportClassName="pr-3">
                {lines.map((line, index) => (
                    <div key={index} className={cn("min-w-full whitespace-pre", markRowTone(line.mark))}>
                        {line.text}
                    </div>
                ))}
            </ScrollPane>
        </div>
    );
}

/**
 * The clock of one call: pi's own number when the result carries it, so the time is the tool's
 * and not this window's; a call still running gets pie's own reading, which the replacement
 * freezes when the result lands.
 */
function useCallClock(id: string, status: ToolStatus, measured: number | null): string | null {
    const [duration, setDuration] = useState<string | null>(null);
    const seen = useRef<{ id: string; startedAt: number | null; endedAt: number | null; running: boolean }>({
        id,
        startedAt: null,
        endedAt: null,
        running: false,
    });

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
                setDuration(formatDuration(now - clock.startedAt));
                return;
            }
            if (!clock.running || clock.startedAt === null) return;
            clock.endedAt ??= now;
            setDuration(formatDuration(clock.endedAt - clock.startedAt));
        };
        const first = setTimeout(() => {
            // A row reused for another call must not show the clock of the call before.
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

    if (measured !== null && status !== "running") return formatDuration(measured);
    return duration;
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${total % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function markTone(mark: string): string {
    if (mark === "+") return "text-success";
    if (mark === "-") return "text-destructive";
    return "text-muted-foreground";
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
