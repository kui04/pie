import type { TranscriptRow } from "@/lib/transcript";
import { ActivityLine } from "@/routes/chat/components/entries/ActivityLine";
import { AssistantMessage } from "@/routes/chat/components/entries/AssistantMessage";
import { NoticeCard } from "@/routes/chat/components/entries/NoticeCard";
import { ToolResultCard } from "@/routes/chat/components/entries/ToolResultCard";
import { UserMessage } from "@/routes/chat/components/entries/UserMessage";
import { presentExecution } from "@/routes/chat/components/toolPresentation";

export interface EntryRendererProps {
    /** The row to draw. */
    row: TranscriptRow;
    /**
     * Drops the queue of the session, for the retract of a message that waits. Pi has
     * no way to take back one message, and the caller says what went.
     */
    onRetractQueued?: () => void;
}

/**
 * One row of the transcript, drawn by the component its kind names. The `never` at
 * the end makes a kind nothing draws the compiler's problem, not a blank row.
 */
export function EntryRenderer({ row, onRetractQueued }: EntryRendererProps) {
    switch (row.kind) {
        case "user":
            return <UserMessage id={row.id} message={row.message} />;
        case "assistant":
            return <AssistantMessage id={row.id} message={row.message} results={row.results} live={row.live} />;
        case "bash":
            return <ToolResultCard id={row.id} presentation={presentExecution(row.message)} />;
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
            return <ActivityLine state={row.state} />;
        case "notice":
            return <NoticeCard id={row.id} label={row.label} summary={row.summary} body={row.body} />;
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
