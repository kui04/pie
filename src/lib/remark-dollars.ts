/**
 * How a model's dollars are read.
 *
 * Money and variables are text: `$5 and then $10`, `$HOME/config`. The questions that tell
 * them from a formula - content ending in whitespace, a digit right after it, a shell variable
 * joined to a word, a backtick inside - come from pi's renderer
 * (`packages/tui/src/components/markdown.ts`), and are asked of a single-dollar pair only.
 *
 * Two dollars is display math wherever it is written, one dollar is inline. micromark reads
 * that backwards (a block only when `$$` owns its line, `$$…$$` inside a line as inline), and a
 * model writes the other way, so every pair of dollars leaves here marked as a block.
 *
 * A pair holding a `$` or a blank line was never a formula - KaTeX can read neither, and one
 * appears when a model's dollars drift apart and swallow the prose between them. That prose
 * comes back as the paragraph it is.
 */

/** The little of an mdast node this walks: whatever else a node carries is not read. */
interface MarkdownNode {
    type?: string;
    value?: string;
    data?: Record<string, unknown>;
    children?: MarkdownNode[];
    position?: {
        start?: { offset?: number };
        end?: { offset?: number };
    };
}

/** `$HOME`, `$PATH_2` and the like, which are variables rather than formulas. */
const VARIABLE = /^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/;

/** The word a variable would be joined to, as in `$HOME/config`. */
const WORD = /^[A-Za-z_][A-Za-z0-9_]*/;

export function remarkDollars() {
    return (tree: MarkdownNode, file: { value?: unknown }) => {
        const source = String(file.value ?? "");
        sort(tree, source);
    };
}

/** Walks the tree, deciding what each dollar pair is. */
function sort(node: MarkdownNode, source: string): void {
    if (node.children === undefined) return;
    node.children = node.children.map((child) => {
        // A block of math, `$$` on a line of its own: already display, but one that swallowed
        // a sentence has to go back as the paragraph it is.
        if (child.type === "math") {
            const raw = slice(child, source);
            if (raw === null || !spoiled(child.value ?? "")) return child;
            return { type: "paragraph", children: [{ type: "text", value: raw }] };
        }

        if (child.type !== "inlineMath") {
            sort(child, source);
            return child;
        }

        const raw = slice(child, source);
        if (raw === null) return child;

        if (raw.startsWith("$$")) return block(child);

        const content = child.value ?? "";
        if (spoiled(content)) return { type: "text", value: raw };

        const after = source.slice(child.position?.end?.offset ?? 0);
        const notMath =
            /\s$/.test(content) ||
            /^\d/.test(after) ||
            (VARIABLE.test(content) && WORD.test(after)) ||
            content.includes("`");
        return notMath ? { type: "text", value: raw } : child;
    });
}

/** The source of one node, or null when it never carried a place in it. */
function slice(node: MarkdownNode, source: string): string | null {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    return start === undefined || end === undefined ? null : source.slice(start, end);
}

/**
 * Whether this content was never a formula: a dollar, an escaped one aside, or a blank line
 * inside it. KaTeX can read neither.
 */
function spoiled(content: string): boolean {
    return content.replace(/\\\$/g, "").includes("$") || /\n\s*\n/.test(content);
}

/** The same node, told to be a block: the class `rehype-katex` reads as display mode. */
function block(node: MarkdownNode): MarkdownNode {
    const data = node.data ?? {};
    const properties = (data.hProperties ?? {}) as Record<string, unknown>;
    return {
        ...node,
        data: { ...data, hProperties: { ...properties, className: ["language-math", "math-display"] } },
    };
}
