import { LoaderCircle, WrapText } from "lucide-react";
import { useState } from "react";
import { motion } from "motion/react";
import { cn } from "cn";
import { Button, CodeBlock, CodeBlockActions, CodeBlockContent } from "@/components/ui";
import { useFollowTail } from "@/hooks/useFollowTail";
import { useMotion } from "@/hooks/useMotion";
import type { NumberedLine } from "@/lib/text";
import type { ToolBody, ToolNote } from "@/routes/chat/transcript/presentation";

/** The height an open body may take before it scrolls inside itself. */
export const BODY_MAX = "max-h-[46vh]";

/**
 * The window of a body that is still arriving: five lines, and then it scrolls - the newest line
 * stays in view, the ends of the box shade where more waits behind them, and the transcript is
 * spared a body that grows without end.
 */
export const LIVE_WINDOW = "max-h-25";

export function Clock({ text }: { text: string }) {
    return <span className="text-label-md tabular-nums">{text}</span>;
}

export function Running() {
    const { turn } = useMotion();
    return (
        <motion.span className="text-primary-text flex shrink-0" {...turn}>
            <LoaderCircle className="size-4" aria-label="Running" />
        </motion.span>
    );
}

/** The whole of what a call produced: a log, or a file or a diff with its own gutter. */
export function Body({ id, body, live }: { id: string; body: ToolBody; live: boolean }) {
    if (body.kind === "log") return <LogBody id={id} lines={body.lines} live={live} />;
    if (body.kind === "none") return null;
    return <NumberedBody id={id} lines={body.lines} />;
}

function LogBody({ id, lines, live }: { id: string; lines: string[]; live: boolean }) {
    const { still } = useMotion();
    const tail = useFollowTail<HTMLPreElement>(live, still);
    // A log scrolls: its lines can be longer than any phone, and wrap is one tap away.
    const [wrap, setWrap] = useState(false);

    return (
        <CodeBlock id={`${id}-log`} size="sm" className="min-w-0">
            <CodeBlockActions>
                <WrapToggle id={`${id}-wrap`} wrap={wrap} onToggle={() => setWrap((was) => !was)} />
            </CodeBlockActions>
            <CodeBlockContent ref={tail} wrap={wrap} className={cn("live-window", live ? LIVE_WINDOW : BODY_MAX)}>
                {lines.join("\n")}
            </CodeBlockContent>
        </CodeBlock>
    );
}

/**
 * A diff, or a file (a diff without marks): two columns, and only the second one scrolls
 * sideways, because a line number that can leave the screen with its line is of no use to a
 * reader. A diff line carries the colour of its mark as a background, painted by both columns
 * so that it runs unbroken.
 */
/**
 * A body whose lines are numbered: a file read, or a diff an edit wrote.
 *
 * The words wrap, and that is what keeps the numbers honest. A pane that scrolls sideways puts
 * the numbers on something that has to hold still while the words move - a second scroller, or a
 * stuck box - and a stuck box is painted at a rounded offset once its pane has been scrolled, so a
 * hairline of the words behind it stays uncovered whatever colour it paints underneath them. Wrapped
 * words need neither: the numbers are one cell of the row they belong to, so they cannot drift from
 * it, they cannot be slid over, and there is no sideways scroll to reveal anything.
 *
 * A line that holds nothing still holds its line, because the number beside it does.
 */
function NumberedBody({ id, lines }: { id: string; lines: NumberedLine[] }) {
    let digits = 1;
    for (const line of lines) digits = Math.max(digits, (line.number ?? "").length);
    // Wrapped until the reader says otherwise: wrap is what keeps each number on its line.
    const [wrap, setWrap] = useState(true);

    return (
        <CodeBlock id={`${id}-lines`} size="sm" className="min-w-0">
            <CodeBlockActions>
                <WrapToggle id={`${id}-wrap`} wrap={wrap} onToggle={() => setWrap((was) => !was)} />
            </CodeBlockActions>
            <CodeBlockContent wrap={wrap} className={cn("text-code font-mono", BODY_MAX)}>
                {lines.map((line, index) => (
                    <div key={index} className={cn("flex", markRowTone(line.mark))}>
                        <span className="flex shrink-0 gap-1 pr-2 select-none">
                            <span className="text-muted-foreground/60 text-right" style={{ width: `${digits}ch` }}>
                                {line.number ?? ""}
                            </span>
                            <span className={cn("w-3 text-center", markTone(line.mark))}>
                                {line.mark.trim() === "" ? " " : line.mark}
                            </span>
                        </span>
                        <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap">{line.text}</span>
                    </div>
                ))}
            </CodeBlockContent>
        </CodeBlock>
    );
}

/**
 * The wash a diff puts over a line it changed, and over the gutter that carries its number and
 * its sign. Both are the same, faint token - the sign's own colour is what says which way the
 * line went - and the two lists have to keep matching each other.
 */
function markRowTone(mark: string): string {
    if (mark === "+") return "bg-success/10";
    if (mark === "-") return "bg-destructive/10";
    return "";
}

/** The sign's own colour: the one place a diff says which way a line went. */
function markTone(mark: string): string {
    if (mark === "+") return "text-success";
    if (mark === "-") return "text-destructive";
    return "text-muted-foreground";
}

/** The wrap key of a tool body: scroll or wrap, per body. */
function WrapToggle({ id, wrap, onToggle }: { id: string; wrap: boolean; onToggle: () => void }) {
    return (
        <Button id={id} variant="ghost" size="icon-xs" aria-label="Wrap lines" aria-pressed={wrap} onClick={onToggle}>
            <WrapText />
        </Button>
    );
}

/** What a row says under its body: a truncation, an exit code. Nothing when there is nothing. */
export function Notes({ notes }: { notes: ToolNote[] }) {
    return (
        <>
            {notes.map((note, index) => (
                <p key={`${note.text}-${index}`} className={cn("text-body-sm", noteTone(note))}>
                    {note.text}
                </p>
            ))}
        </>
    );
}

function noteTone(note: ToolNote): string {
    if (note.tone === "warning") return "text-warning";
    if (note.tone === "error") return "text-destructive";
    return "text-muted-foreground";
}
