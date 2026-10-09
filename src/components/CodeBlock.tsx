import { Copy, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { copyText } from "@/lib/clipboard";

export interface CodeBlockProps {
    /** The code, exactly as it arrived. */
    code: string;
    /** The language of the fence, when the markdown named one. */
    language?: string;
    /** The base of the control ids, when the caller has a unique one to give. */
    id?: string;
    className?: string;
}

/**
 * A fenced code block: the language, a copy key, and the code in mono.
 *
 * The copy key is a courtesy and not a way to get the text out: the code is
 * selectable like any other text, so a clipboard this webview refuses leaves the
 * reader with the text rather than with a wrong answer.
 */
export function CodeBlock({ code, language, id, className }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = () => {
        void copyText(code).then((copied) => {
            if (copied) setCopied(true);
        });
    };

    return (
        <div className={cn("bg-card overflow-hidden rounded-md", className)} data-language={language ?? "text"}>
            <div className="flex items-center justify-between gap-2 py-1 pr-1 pl-3">
                <span className="text-label-sm text-muted-foreground font-mono">{language ?? "text"}</span>
                <Button
                    id={id === undefined ? undefined : `${id}-copy`}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy code"
                    onClick={copy}
                >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
            </div>
            {/* The padding the block used to carry, on the box that scrolls: the
                last character keeps its air to the side, and the bar floats over the
                air under the last line - a padding on the frame would not move it,
                because an absolute child is placed against the padding box. */}
            <ScrollArea bars="horizontal" viewportClassName="px-3 pb-3">
                <pre className="text-code font-mono">
                    <code>{code}</code>
                </pre>
            </ScrollArea>
        </div>
    );
}
