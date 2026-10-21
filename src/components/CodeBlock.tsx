import { Copy, Check, WrapText } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ScrollPane } from "./ScrollPane";
import {
    Button,
    CodeBlock as CodeBlockFrame,
    CodeBlockActions,
    CodeBlockContent,
    CodeBlockHeader,
    CodeBlockLine,
    CodeBlockTitle,
} from "@/components/ui";
import { asPieError, log } from "@/lib/bridge";
import {
    ensureLanguage,
    highlighterVersion,
    loadedHighlighter,
    subscribeToHighlighter,
    tokensOf,
} from "@/lib/highlight";
import { copyText } from "@/lib/clipboard";
import { Icon } from "./Icon";
import { TruncatedText } from "./TruncatedText";

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
/** The pane owns the scroll, so the content's fade has nothing to follow. */
const CONTENT_STYLE = { maskImage: "none", WebkitMaskImage: "none" };
export function CodeBlock({ code, language, id, className }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    // Long lines scroll: a phone is narrow, and wrap is one tap away.
    const [wrap, setWrap] = useState(false);
    const version = useSyncExternalStore(subscribeToHighlighter, highlighterVersion, highlighterVersion);
    const highlighter = loadedHighlighter();

    // The chunk is asked for after the first paint, so nothing waits on colours that only a
    // code block needs. A grammar outside the common chunk is asked for by name.
    useEffect(() => {
        void ensureLanguage(language ?? "text").catch((thrown: unknown) => {
            log.warn("the syntax highlighter did not load", { reason: asPieError(thrown).message });
        });
    }, [highlighter, language, version]);

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

    // A final newline ends the last line; shiki would draw it as an empty one.
    const drawn = code.replace(/\r?\n$/, "");
    const tokens = coloured === code ? tokensOf(highlighter, drawn, language ?? "text") : null;

    const copy = () => {
        void copyText(code).then((done) => {
            if (done) setCopied(true);
        });
    };

    return (
        <CodeBlockFrame className={className} data-language={language ?? "text"}>
            <CodeBlockHeader>
                <CodeBlockTitle>
                    <TruncatedText content={language ?? "text"} offset={{ top: 6, right: 12, bottom: 6, left: 12 }}>
                        {language ?? "text"}
                    </TruncatedText>
                </CodeBlockTitle>
                <CodeBlockActions>
                    <Button
                        id={id === undefined ? undefined : `${id}-wrap`}
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Wrap lines"
                        aria-pressed={wrap}
                        onClick={() => setWrap((was) => !was)}
                    >
                        <Icon>
                            <WrapText />
                        </Icon>
                    </Button>
                    <Button
                        id={id === undefined ? undefined : `${id}-copy`}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={copied ? "Copied" : "Copy code"}
                        onClick={copy}
                    >
                        {copied ? (
                            <Icon>
                                <Check />
                            </Icon>
                        ) : (
                            <Icon>
                                <Copy />
                            </Icon>
                        )}
                    </Button>
                    <span aria-live="polite" className="sr-only">
                        {copied ? "Copied" : ""}
                    </span>
                </CodeBlockActions>
            </CodeBlockHeader>
            {/* The tokens carry both palettes as custom properties and `index.css`
                chooses between them, so the same code is drawn in either scheme
                without a render. */}
            <ScrollPane bars="horizontal" className="min-w-0">
                <CodeBlockContent
                    data-code={language ?? "text"}
                    wrap={wrap}
                    className="overflow-visible"
                    style={CONTENT_STYLE}
                >
                    {tokens === null
                        ? drawn
                        : tokens.map((line, at) => (
                              <CodeBlockLine key={at}>
                                  {line.map((token, of) => (
                                      <span key={of} style={token.vars}>
                                          {token.text}
                                      </span>
                                  ))}
                              </CodeBlockLine>
                          ))}
                </CodeBlockContent>
            </ScrollPane>
        </CodeBlockFrame>
    );
}
