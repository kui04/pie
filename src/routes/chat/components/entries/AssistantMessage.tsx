import { LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Markdown } from "@/components/Markdown";
import type { AssistantMessage as AssistantMessageData, ToolResultMessage } from "@/lib/protocol";
import { SPIN, SPIN_TURN } from "@/lib/motion";
import { ThinkingCard } from "@/routes/chat/components/entries/ThinkingCard";
import { ToolResultCard } from "@/routes/chat/components/entries/ToolResultCard";
import { presentCall } from "@/routes/chat/components/toolPresentation";

export interface AssistantMessageProps {
    /** The entry this card draws, as the base of its ids. */
    id: string;
    message: AssistantMessageData;
    /** What the calls of this message answered, by call id. */
    results: Map<string, ToolResultMessage>;
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
export function AssistantMessage({ id, message, results }: AssistantMessageProps) {
    const note = stopNote(message);

    // While the turn is unsettled the transcript shows pi's `Working…` line.
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
                    return (
                        <ToolResultCard
                            key={`call-${part.id}`}
                            id={`${id}-${part.id}`}
                            presentation={presentCall(
                                part.name,
                                part.arguments,
                                results.get(part.id) ?? failedCall(message, part.id, part.name),
                                working,
                            )}
                        />
                    );
                }
                // A block kind this build does not know: nothing to draw, nothing cast.
                return null;
            })}
            {note !== null && <p className="text-body-sm text-destructive">{note}</p>}
            {working && (
                <p className="text-body-md text-muted-foreground flex items-center gap-2">
                    <WorkingMark />
                    Working…
                </p>
            )}
        </div>
    );
}

/** The ring that says the model is writing; still for a machine that asks for less. */
function WorkingMark() {
    const still = useReducedMotion();
    return (
        <motion.span
            className="text-primary-text flex shrink-0"
            animate={still ? undefined : SPIN_TURN}
            transition={SPIN}
        >
            <LoaderCircle className="size-4" aria-label="Working" />
        </motion.span>
    );
}

/**
 * What the line under the answer says when the turn ended badly: pi shows it only
 * when the message called no tools, whose cards carry the failure instead.
 */
function stopNote(message: AssistantMessageData): string | null {
    if (message.stopReason === "length") return "Response was truncated before completion.";
    if (message.content.some((part) => part.type === "toolCall")) return null;
    const reason = failureText(message);
    if (reason === null) return null;
    return message.stopReason === "error" ? `Error: ${reason}` : reason;
}

/**
 * The failure of a turn, for the line under it and for the cards it left waiting.
 */
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

/**
 * A result for a call the turn never answered, as pi's rebuild does: a call of an
 * aborted or errored turn must not wait for an answer that is not coming.
 */
function failedCall(message: AssistantMessageData, toolCallId: string, toolName: string): ToolResultMessage | null {
    const text = failureText(message);
    if (text === null) return null;
    return {
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: true,
        timestamp: message.timestamp,
    };
}
