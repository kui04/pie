import { X } from "lucide-react";
import { useState } from "react";
import { Body, Clock, Notes, Running } from "@/routes/chat/transcript/entries/CallBody";
import { useCallClock } from "@/hooks/useCallClock";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { glyphFor } from "@/routes/chat/transcript/entries/ToolGlyph";
import type { ToolPresentation, ToolStatus } from "@/routes/chat/transcript/presentation";
import { Icon } from "@/components";

export interface UserCommandProps {
    /** The run this row draws, as the base of its ids. */
    id: string;
    /** The shell it ran in, for the glyph at the head of the row. */
    tool: string;
    /** The run and its output, already read into the shape a row shows. */
    presentation: ToolPresentation;
    /** Whether this row stands outside a fold, so its body carries a line of its own. */
    quote?: boolean;
}

/**
 * One command the reader ran themselves, as a single row: pi's own prompt, the
 * command, and the clock it kept. It is the same family as a call the model
 * made, in the colour of the reader's own run - and its own component, so the
 * two can change apart from each other.
 */
export function UserCommand({ id, tool, presentation, quote = false }: UserCommandProps) {
    // A run at work is read while it happens, and folds itself away once it settles: the
    // reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const { title, detail, status, body, notes } = presentation;
    const open = manual ?? status === "running";
    const clock = useCallClock(id, status, presentation.durationMs);
    const lines = body.kind === "none" ? [] : body.lines;
    const end =
        status === "running" || status === "failed" || clock !== null ? (
            <End status={status} clock={clock} />
        ) : undefined;

    return (
        <Row
            id={id}
            glyph={glyphFor(tool)}
            name={title}
            tone="user-run"
            target={detail}
            end={end}
            quote={quote}
            open={open}
            onToggle={() => setManual((was) => !(was ?? status === "running"))}
        >
            {lines.length > 0 && <Body id={id} body={body} live={status === "running"} />}
            <Notes notes={notes} />
        </Row>
    );
}

/** What the row's end says: a clock, a ring while it runs, a mark when it failed. */
function End({ status, clock }: { status: ToolStatus; clock: string | null }) {
    return (
        <>
            {status === "running" ? <Running /> : clock !== null && <Clock text={clock} />}
            {status === "failed" && (
                <Icon className="text-destructive">
                    <X aria-label="Failed" />
                </Icon>
            )}
        </>
    );
}
