import type { TranscriptRow } from "@/lib/transcript";
import { AssistantMessage } from "@/routes/chat/components/entries/AssistantMessage";
import { NoticeCard } from "@/routes/chat/components/entries/NoticeCard";
import { ToolResultCard } from "@/routes/chat/components/entries/ToolResultCard";
import { UserMessage } from "@/routes/chat/components/entries/UserMessage";
import { presentExecution } from "@/routes/chat/components/toolPresentation";

/**
 * One row of the transcript, drawn by the component its kind names. The `never` at
 * the end makes a kind nothing draws the compiler's problem, not a blank row.
 */
export function EntryRenderer({ row }: { row: TranscriptRow }) {
    switch (row.kind) {
        case "user":
            return <UserMessage id={row.id} message={row.message} />;
        case "assistant":
            return <AssistantMessage id={row.id} message={row.message} results={row.results} />;
        case "bash":
            return <ToolResultCard id={row.id} presentation={presentExecution(row.message)} />;
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
