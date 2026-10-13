import { Copy, Check } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { ScrollPane } from "@/components/ScrollPane";
import { useHighlighter } from "@/hooks/use-highlighter";
import { tokensOf } from "@/lib/code-highlight";
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

/** How long the words of a block have to stand still before its colours are made. */
const QUIET_MS = 180;
export function CodeBlock({ code, language, id, className }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const highlighter = useHighlighter();

    // The code the colours were made for. A block that is still arriving is redrawn on every
    // frame of a run, and colouring a long one costs a frame of its own (measured: 15ms for a
    // hundred and twenty lines), so the words are drawn at once and the colours wait a moment
    // for them to stop. A block that never changes is coloured on its first draw.
    const [coloured, setColoured] = useState(code);

    useEffect(() => {
        if (coloured === code) return;
        const timer = setTimeout(() => setColoured(code), QUIET_MS);
        return () => clearTimeout(timer);
    }, [code, coloured]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    const tokens = coloured === code ? tokensOf(highlighter, code, language ?? "text") : null;

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
            <ScrollPane bars="horizontal" viewportClassName="px-3 pb-3">
                {/* The tokens carry both palettes as custom properties and `index.css`
                    chooses between them, so the same code is drawn in either scheme
                    without a render. */}
                <pre className="text-code font-mono" data-code={language ?? "text"}>
                    <code>
                        {tokens === null
                            ? code
                            : tokens.map((line, at) => (
                                  <Fragment key={at}>
                                      {at === 0 ? null : "\n"}
                                      {line.map((token, of) => (
                                          <span key={of} style={token.vars}>
                                              {token.text}
                                          </span>
                                      ))}
                                  </Fragment>
                              ))}
                    </code>
                </pre>
            </ScrollPane>
        </div>
    );
}
