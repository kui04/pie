import { isValidElement, memo, type ReactNode } from "react";
import { cn } from "cn";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { openUrl } from "@/lib/bridge";
import { CodeBlock } from "@/components/CodeBlock";

/** The schemes pie opens. A link of any other stays the text it is. */
const OPENABLE = /^(https?|mailto):/i;

export interface MarkdownProps {
    /** The markdown source, exactly as it arrived from the protocol. */
    children: string;
    /** The place this renderer draws, as the base of the ids of what it draws. */
    id?: string;
    className?: string;
}

/**
 * The app's single markdown renderer (react-markdown + remark-gfm).
 *
 * Memoized: react-markdown parses its source on every render, and a transcript
 * re-renders once per event.
 */
export const Markdown = memo(MarkdownInner);

function MarkdownInner({ children, id, className }: MarkdownProps) {
    return (
        <div className={cn("text-body-md text-foreground space-y-3", className)}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    h1: ({ children: content }) => <h1 className="text-headline-md font-semibold">{content}</h1>,
                    h2: ({ children: content }) => <h2 className="text-title-lg font-semibold">{content}</h2>,
                    h3: ({ children: content }) => <h3 className="text-title-md font-semibold">{content}</h3>,
                    h4: ({ children: content }) => <h4 className="text-title-sm font-semibold">{content}</h4>,
                    p: ({ children: content }) => <p className="text-body-md">{content}</p>,
                    ul: ({ children: content }) => <ul className="list-disc space-y-1 pl-5">{content}</ul>,
                    ol: ({ children: content }) => <ol className="list-decimal space-y-1 pl-5">{content}</ol>,
                    li: ({ children: content }) => <li className="text-body-md">{content}</li>,
                    blockquote: ({ children: content }) => (
                        <blockquote className="border-border text-muted-foreground border-l-2 pl-3">
                            {content}
                        </blockquote>
                    ),
                    a: ({ href, children: content }) =>
                        href !== undefined && OPENABLE.test(href) ? (
                            <a
                                href={href}
                                // A link belongs to the browser of the machine, not to the
                                // window pie speaks to pi through: every way of following one
                                // goes to Rust, which checks the scheme first.
                                onClick={(event) => {
                                    event.preventDefault();
                                    void openUrl(href).catch(() => toast.error("That link was not opened."));
                                }}
                                onAuxClick={(event) => {
                                    // A middle click is a click on the same link: same way out.
                                    if (event.button !== 1) return;
                                    event.preventDefault();
                                    void openUrl(href).catch(() => toast.error("That link was not opened."));
                                }}
                                className="text-primary underline-offset-4 hover:underline"
                            >
                                {content}
                            </a>
                        ) : (
                            <>{content}</>
                        ),
                    hr: () => <hr className="border-border" />,
                    table: ({ children: content }) => (
                        <div className="overflow-x-auto">
                            <table className="text-body-sm w-full border-collapse">{content}</table>
                        </div>
                    ),
                    th: ({ children: content }) => (
                        <th className="border-border bg-muted border px-2 py-1 text-left font-medium">{content}</th>
                    ),
                    td: ({ children: content }) => <td className="border-border border px-2 py-1">{content}</td>,
                    // A fenced block arrives as `pre > code`. It goes to CodeBlock
                    // whether or not the fence named a language - a block without one
                    // is not an inline snippet, and would otherwise collapse into a pill.
                    pre: ({ children: content, node }) => {
                        const only = Array.isArray(content) ? content[0] : content;
                        const fence = isValidElement<{ className?: string }>(only) ? only.props.className : undefined;
                        // A `pre` that holds no `code` - raw text, or more than the one
                        // child - is its own text: a block of it beats an empty card.
                        const code = isValidElement<{ children?: ReactNode }>(only)
                            ? textOf(only.props.children)
                            : textOf(content);
                        const language =
                            fence?.startsWith("language-") === true ? fence.slice("language-".length) : "text";
                        return (
                            <CodeBlock
                                code={code}
                                language={language}
                                id={id === undefined ? undefined : `${id}-code-${node?.position?.start.line ?? 0}`}
                                className="my-3"
                            />
                        );
                    },
                    code: ({ children: content }) => (
                        <code className="bg-muted text-code rounded-sm px-1 py-0.5 font-mono">{content}</code>
                    ),
                }}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
}

/** The text of a markdown child: the renderers below hand strings and elements. */
function textOf(children: ReactNode): string {
    if (Array.isArray(children)) return children.map(textOf).join("");
    if (children === undefined || children === null) return "";
    if (typeof children === "string" || typeof children === "number") return String(children);
    // An element (a link inside a fence, say): its own children carry the text.
    if (isValidElement<{ children?: ReactNode }>(children)) return textOf(children.props.children);
    return "";
}
