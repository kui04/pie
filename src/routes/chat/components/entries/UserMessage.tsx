import { Clock, Copy, Undo2 } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { copyText } from "@/lib/clipboard";
import { messageText } from "@/lib/text";
import type { UserMessage as UserMessageData } from "@/lib/protocol";

export interface UserMessageProps {
    /** The entry this card draws, as the base of its ids. */
    id: string;
    message: UserMessageData;
    /**
     * The queue this message waits in. Only a message that pi has not run has this:
     * the bubble dims, and it says where it waits.
     */
    queued?: "steer" | "followUp";
    /**
     * Drops the queue that this message waits in. Pi has no way to take back one
     * message, so this drops them all (G7 of the plan).
     */
    onRetract?: () => void;
}

/**
 * What the reader asked, on their side of the transcript. Every bubble has the same
 * corners as a tile, whatever the words inside: only the box follows them, a single
 * line taking a tighter one than a paragraph. The actions are a menu on the bubble
 * itself (a right-click, or the long press a touch screen turns into one), not a key
 * in a corner of the reader's own words.
 */
export function UserMessage({ id, message, queued, onRetract }: UserMessageProps) {
    const images = imagesOf(message);
    const text = messageText(message.content);
    // A line short enough to be one line sits in a tighter box than a paragraph; a
    // picture takes the box a paragraph takes.
    const oneLine = images.length === 0 && !text.includes("\n") && text.length <= 60;

    const copy = () => {
        // The menu closes as it fires, so the word comes back as the toast.
        void copyText(text).then((copied) => {
            if (copied) toast.success("Copied.");
        });
    };

    const bubble = (
        <div
            id={id}
            // Focusable, so the menu of the bubble can be opened from a keyboard
            // (the ContextMenu key or Shift+F10 raises the event Radix listens for).
            tabIndex={0}
            aria-label="Your message"
            className={cn(
                "bg-primary text-primary-foreground focus-visible:ring-ring max-w-[80%] min-w-0 space-y-2 break-words outline-none focus-visible:ring-2",
                // One shape for every bubble, and the shape a tile takes: what the line
                // count changes is the air around the words, never the corner.
                "rounded-md",
                oneLine ? "px-4 py-2" : "p-3",
                // A message that waits is not in the conversation yet: it reads as
                // quieter than the words around it.
                queued !== undefined && "opacity-60",
            )}
        >
            {images.map((image, index) => (
                <img
                    key={index}
                    alt="what the request showed"
                    src={`data:${image.mimeType};base64,${image.data}`}
                    className="max-h-64 rounded-md"
                />
            ))}
            {text !== "" && (
                <Markdown
                    id={`${id}-text`}
                    // On this bubble the page is the colour of the bubble, so a link and
                    // a code pill are repainted for the one place they sit on.
                    className="text-body-md text-primary-foreground [&_a]:text-primary-foreground [&_code]:bg-primary-foreground/20 space-y-2 [&_a]:underline"
                >
                    {text}
                </Markdown>
            )}
        </div>
    );

    return (
        // `relative` holds the caption, which hangs below the bubble's own box; the
        // room under it (24px, the design's space-xl) is what keeps the next row clear.
        <div className={cn("relative flex flex-col items-end", queued !== undefined && "pb-6")}>
            {text === "" ? (
                bubble
            ) : (
                <ContextMenu>
                    {/* The trigger is `select-none` by default; the reader's own words
                        are worth being able to select. */}
                    <ContextMenuTrigger asChild className="select-text">
                        {bubble}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem onSelect={copy}>
                            <Copy className="size-4" />
                            Copy
                        </ContextMenuItem>
                        {queued !== undefined && onRetract !== undefined && (
                            <ContextMenuItem onSelect={onRetract}>
                                <Undo2 className="size-4" />
                                Retract queued message
                            </ContextMenuItem>
                        )}
                    </ContextMenuContent>
                </ContextMenu>
            )}
            {queued !== undefined && (
                <p className="text-body-md text-muted-foreground absolute top-full right-0 mt-1 flex items-center gap-1">
                    <Clock className="size-4 shrink-0" aria-hidden />
                    queued · {queued === "steer" ? "steer" : "follow-up"}
                </p>
            )}
        </div>
    );
}

/** The images of a request, which sit above its words when it has any. */
function imagesOf(message: UserMessageData): Array<{ data: string; mimeType: string }> {
    if (typeof message.content === "string") return [];
    return message.content.filter((part) => part.type === "image");
}
