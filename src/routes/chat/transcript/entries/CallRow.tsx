import { X } from "lucide-react";
import { useState } from "react";
import { Body, Clock, Notes, Running } from "@/routes/chat/transcript/entries/CallBody";
import { useCallClock } from "@/hooks/useCallClock";
import { Row } from "@/routes/chat/transcript/entries/Row";
import { glyphFor, toolLabel } from "@/routes/chat/transcript/entries/ToolGlyph";
import type { ToolPresentation, ToolStatus } from "@/routes/chat/transcript/presentation";
import { Icon } from "@/components";

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

/**
 * One call the model made, as a single row: the glyph of its kind, its name,
 * what it aimed at, and the clock it kept. The whole of what it produced waits
 * behind the row - nothing is previewed - and it arrives flat, at the row's own
 * text column, under no frame of its own.
 */
export function CallRow({ id, tool, presentation, quote = false }: CallRowProps) {
    // A call that runs is read while it runs, and folds itself away once it settles: the
    // reader's own toggle wins from then on.
    const [manual, setManual] = useState<boolean | null>(null);
    const { detail, tone, status, body, notes } = presentation;
    const lines = body.kind === "none" ? [] : body.lines;
    const hasBody = lines.length > 0 || notes.length > 0;
    const open = hasBody && (manual ?? status === "running");
    const clock = useCallClock(id, status, presentation.durationMs);
    // The name of the tool, spelled as a name rather than as pi's identifier for it.
    const name = toolLabel(tool);
    const end =
        status === "running" || status === "failed" || clock !== null ? (
            <End status={status} clock={clock} />
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
            onToggle={() => setManual((was) => !(was ?? open))}
        >
            {hasBody && (
                <>
                    {lines.length > 0 && <Body id={id} body={body} live={status === "running"} />}
                    <Notes notes={notes} />
                </>
            )}
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
