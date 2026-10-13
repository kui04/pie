import { isValidElement, memo, useMemo, type ReactNode } from "react";
import "katex/dist/katex.min.css";
import { cn } from "cn";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkDollars } from "@/lib/remark-dollars";
import { toast } from "sonner";
import { openUrl } from "@/lib/bridge";
import { CodeBlock } from "@/components/CodeBlock";
import { ScrollPane } from "@/components/ScrollPane";

/** The schemes pie opens. A link of any other stays the text it is. */
const OPENABLE = /^(https?|mailto):/i;

export interface MarkdownProps {
    /** The markdown source, exactly as it arrived from the protocol. */
    children: string;
    /** The place this renderer draws, as the base of the ids of what it draws. */
    id?: string;
    className?: string;
}

export const Markdown = memo(MarkdownInner);

/**
 * The last parse of each row, so that a row drawn again is not parsed again:
 * react-markdown parses the whole string on every render - a typical answer costs
 * about three milliseconds of that - and a screenful of rows in one scroll frame is
 * a frame the reader waits for.
 *
 * Keyed by the row's id, with the source kept beside it, so a reply still being
 * written replaces its own entry instead of filling the cache.
 */
const CACHED = 200;
const parses = new Map<string, { source: string; node: ReactNode }>();

/** What react-markdown draws for one source, from the cache when it can be. */
function parsed(id: string | undefined, options: Options): ReactNode {
    const source = options.children ?? "";
    const kept = id === undefined ? undefined : parses.get(id);
    if (kept !== undefined && kept.source === source) return kept.node;

    // Called rather than rendered: this component is a plain function with no hooks
    // (`MarkdownHooks` is the other one), so its result can be kept and drawn again.
    const node = ReactMarkdown(options);
    if (id !== undefined) {
        parses.delete(id);
        parses.set(id, { source, node });
        if (parses.size > CACHED) {
            for (const oldest of parses.keys()) {
                parses.delete(oldest);
                break;
            }
        }
    }
    return node;
}

function MarkdownInner({ children, id, className }: MarkdownProps) {
    // Built again only for another row: React tells components apart by their function,
    // so a renderer made anew on each of the run's frames would unmount every paragraph
    // of the message instead of writing the new words into it.
    const components = useMemo<Components>(
        () => ({
            h1: ({ children: content }) => <h1 className="text-headline-md font-semibold">{content}</h1>,
            h2: ({ children: content }) => <h2 className="text-title-lg font-semibold">{content}</h2>,
            h3: ({ children: content }) => <h3 className="text-title-md font-semibold">{content}</h3>,
            h4: ({ children: content }) => <h4 className="text-title-sm font-semibold">{content}</h4>,
            p: ({ children: content }) => <p className="text-body-md">{content}</p>,
            ul: ({ children: content }) => <ul className="list-disc space-y-1 pl-5">{content}</ul>,
            ol: ({ children: content }) => <ol className="list-decimal space-y-1 pl-5">{content}</ol>,
            li: ({ children: content }) => <li className="text-body-md">{content}</li>,
            blockquote: ({ children: content }) => (
                <blockquote className="border-divider text-muted-foreground border-l-2 pl-3">{content}</blockquote>
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
                        className="text-primary-text underline-offset-4 hover:underline"
                    >
                        {content}
                    </a>
                ) : (
                    <>{content}</>
                ),
            hr: () => <hr className="border-divider" />,
            table: ({ children: content }) => (
                <ScrollPane bars="horizontal">
                    <table className="text-body-sm w-full border-collapse">{content}</table>
                </ScrollPane>
            ),
            th: ({ children: content }) => (
                <th className="border-divider bg-muted border px-2 py-1 text-left font-medium">{content}</th>
            ),
            td: ({ children: content }) => <td className="border-divider border px-2 py-1">{content}</td>,
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
                const language = fence?.startsWith("language-") === true ? fence.slice("language-".length) : "text";
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
        }),
        [id],
    );

    return (
        <div className={cn("text-body-md text-foreground space-y-3", className)}>
            {parsed(id, {
                children,
                // GFM for the tables and the task lists a model writes; math for the formulas,
                // which `rehype-katex` turns into the same markup the reader of a paper sees;
                // breaks because a model's single newline is a line it means to end - pi's own
                // renderer answers the same way.
                remarkPlugins: [remarkGfm, remarkMath, remarkDollars, remarkBreaks],
                rehypePlugins: [[rehypeKatex, { errorColor: "var(--destructive)" }]],
                components,
            })}
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
