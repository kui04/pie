import { Markdown } from "@/components";
import type { AssistantMessage as AssistantMessageData, ToolResultMessage } from "@/lib/rpc-protocol";
import type { LiveCall } from "@/lib/stream";
import { ThinkingCard } from "@/routes/chat/components/entries/ThinkingCard";
import { ToolResultCard } from "@/routes/chat/components/entries/ToolResultCard";
import { presentCall } from "@/routes/chat/components/toolPresentation";

export interface AssistantMessageProps {
    /** The entry this card draws, as the base of its ids. */
    id: string;
    message: AssistantMessageData;
    /** What the calls of this message answered, by call id. */
    results: Map<string, ToolResultMessage>;
    /**
     * Set while the run still writes this message, with what it streamed for each call
     * (`lib/stream.ts`); the read that follows the run drops it.
     */
    live?: { calls: Map<string, LiveCall>; retrying: boolean };
}

/**
 * One answer of the model, block by block: what it thought, what it said, and what
 * it asked the tools to do.
 *
 * A turn that did not end cleanly says so once, following pi's rule
 * (`modes/interactive/components/assistant-message.ts`): a truncated answer always
 * gets the line, an abort or an error does not when the message called tools - the
 * call that took the failure shows it.
 */
export function AssistantMessage({ id, message, results, live }: AssistantMessageProps) {
    const note = live?.retrying ? null : stopNote(message);
    const working = message.stopReason === "pending";

    return (
        <div className="flex min-w-0 flex-col gap-2">
            {message.content.map((part, index) => {
                if (part.type === "thinking") {
                    return (
                        <ThinkingCard
                            key={`thinking-${index}`}
                            id={`${id}-${index}`}
                            thinking={part.thinking}
                            stillThinking={working}
                        />
                    );
                }
                if (part.type === "text") {
                    if (part.text.trim() === "") return null;
                    return (
                        <Markdown key={`text-${index}`} id={`${id}-text-${index}`} className="text-body-md">
                            {part.text}
                        </Markdown>
                    );
                }
                if (part.type === "toolCall") {
                    const call = live?.calls.get(part.id);
                    return (
                        <ToolResultCard
                            key={`call-${part.id}`}
                            id={`${id}-${part.id}`}
                            presentation={presentCall(
                                part.name,
                                part.arguments,
                                call?.result ?? results.get(part.id) ?? failedCall(message, part.id, part.name),
                                working,
                                call?.running ?? false,
                            )}
                        />
                    );
                }
                return null;
            })}
            {note !== null && <p className="text-body-sm text-destructive">{note}</p>}
        </div>
    );
}

function stopNote(message: AssistantMessageData): string | null {
    if (message.stopReason === "length") return "Response was truncated before completion.";
    if (message.content.some((part) => part.type === "toolCall")) return null;
    const reason = failureText(message);
    if (reason === null) return null;
    return message.stopReason === "error" ? `Error: ${reason}` : reason;
}

function failureText(message: AssistantMessageData): string | null {
    if (message.stopReason === "aborted") {
        const said = message.errorMessage;
        return said !== undefined && said !== null && said !== "" && said !== "Request was aborted"
            ? said
            : "Operation aborted";
    }
    if (message.stopReason === "error") return message.errorMessage || "Unknown error";
    return null;
}

function failedCall(message: AssistantMessageData, toolCallId: string, toolName: string): ToolResultMessage | null {
    const text = failureText(message);
    if (text === null) return null;
    return {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: true,
        timestamp: message.timestamp,
    };
}
