import { cn } from "cn";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownProps {
    /** The markdown source, exactly as it arrived from the protocol. */
    children: string;
    className?: string;
}

/**
 * The app's single markdown renderer (react-markdown + remark-gfm).
 *
 * Each mapping renders its children explicitly instead of spreading
 * react-markdown's `node` extra prop onto DOM elements.
 *
 * Fenced code blocks are styled inline for now; the dedicated CodeBlock card
 * (header with language + copy key) arrives with the transcript milestone.
 */
export function Markdown({ children, className }: MarkdownProps) {
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
                    a: ({ href, children: content }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline-offset-4 hover:underline"
                        >
                            {content}
                        </a>
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
                    // A fenced block arrives as `pre > code` with a
                    // `language-*` class; the `code` renderer draws the block
                    // itself, so `pre` only unwraps its child.
                    pre: ({ children: content }) => <>{content}</>,
                    code: ({ className: codeClassName, children: content }) => {
                        const language = codeClassName?.startsWith("language-")
                            ? codeClassName.slice("language-".length)
                            : undefined;
                        if (language !== undefined) {
                            return (
                                <pre
                                    data-language={language}
                                    className="border-border-subtle bg-muted text-code overflow-x-auto rounded-md border p-3 font-mono"
                                >
                                    <code>{content}</code>
                                </pre>
                            );
                        }
                        return <code className="bg-muted text-code rounded-sm px-1 py-0.5 font-mono">{content}</code>;
                    },
                }}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
}
