import type { TranscriptRow } from "@/lib/transcript";
import { CallRow } from "@/routes/chat/transcript/entries/CallRow";
import { Notice } from "@/routes/chat/transcript/entries/Notice";
import { RunLine } from "@/routes/chat/transcript/entries/RunLine";
import { UserMessage } from "@/routes/chat/transcript/entries/UserMessage";
import { presentExecution } from "@/routes/chat/transcript/presentation";

/** A row a turn's fold leaves where it stands: every kind but the assistant's own messages. */
export type EntryRow = Exclude<TranscriptRow, { kind: "assistant" }>;

export interface TranscriptEntryProps {
    /** The row to draw. */
    row: EntryRow;
    /**
     * Drops the queue of the session, for the retract of a message that waits. Pi has
     * no way to take back one message, and the caller says what went.
     */
    onRetractQueued?: () => void;
}

/**
 * One row of the transcript, drawn by the component its kind names. A call the reader ran is a
 * row of the same family as a call the model made; a turn's own work never reaches here, because
 * the fold takes it. The `never` at the end makes a kind nothing draws the compiler's problem,
 * not a blank row.
 */
export function TranscriptEntry({ row, onRetractQueued }: TranscriptEntryProps) {
    switch (row.kind) {
        case "user":
            return <UserMessage id={row.id} message={row.message} />;
        case "bash":
            // A command the reader ran: the same row as a call, in the colour of their own run.
            return <CallRow id={row.id} tool="bash" presentation={presentExecution(row.message)} />;
        case "queued":
            // A queued prompt is the reader's own message that pi has not run: the
            // same bubble, dimmed, with the queue it waits in under it.
            return (
                <UserMessage
                    id={row.id}
                    message={{ role: "user", content: row.text, timestamp: 0 }}
                    queued={row.queue}
                    onRetract={onRetractQueued}
                />
            );
        case "activity":
            return <RunLine state={row.state} />;
        case "notice":
            return <Notice id={row.id} label={row.label} summary={row.summary} body={row.body} />;
        default: {
            const unhandled: never = row;
            return nothing(unhandled);
        }
    }
}

/** A kind nothing draws: nothing, rather than an object React cannot render. */
function nothing(row: never): null {
    void row;
    return null;
}
