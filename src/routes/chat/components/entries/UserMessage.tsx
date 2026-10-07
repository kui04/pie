import { Copy } from "lucide-react";
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
}

/**
 * What the reader asked, on their side of the transcript. A question of one line is
 * a pill and anything longer is a card. The actions are a menu on the bubble itself
 * (a right-click, or the long press a touch screen turns into one), not a key in a
 * corner of the reader's own words.
 */
export function UserMessage({ id, message }: UserMessageProps) {
    const images = imagesOf(message);
    const text = messageText(message.content);
    // A pill is for a short line: a long one has no line to be a pill around.
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
                "bg-primary text-primary-foreground focus-visible:ring-ring max-w-[85%] min-w-0 space-y-2 break-words outline-none focus-visible:ring-2",
                oneLine ? "rounded-full px-4 py-2" : "rounded-xl p-3",
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
        <div className="flex justify-end">
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
                    </ContextMenuContent>
                </ContextMenu>
            )}
        </div>
    );
}

/** The images of a request, which sit above its words when it has any. */
function imagesOf(message: UserMessageData): Array<{ data: string; mimeType: string }> {
    if (typeof message.content === "string") return [];
    return message.content.filter((part) => part.type === "image");
}
