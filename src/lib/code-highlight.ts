import type { HighlighterCore } from "shiki/core";

/**
 * The app's syntax colours, one chunk away: `shiki` is imported when the first code block is
 * drawn and never before, so the window opens without it (`rules/frontend.md` forbids a
 * highlighter in the initial load). Until the chunk lands, a block is plain text.
 *
 * Tokens carry both palettes at once as custom properties, and `src/index.css` picks the one
 * the reader's scheme asks for: a scheme change recolours code without a render.
 */

export interface CodeToken {
    text: string;
    /** Custom properties for this token, spread into an element's `style`. */
    vars: Record<string, string>;
}

/** One call's tokens, so a settled block is not tokenized twice. */
const KEPT = 80;

type Reader = () => void;

const readers = new Set<Reader>();
let highlighter: HighlighterCore | null = null;
let loading: Promise<void> | null = null;

const cache = new Map<string, CodeToken[][]>();

/** Told when the highlighter arrives: what `useSyncExternalStore` subscribes to. */
export function subscribeToHighlighter(reader: Reader): () => void {
    readers.add(reader);
    return () => readers.delete(reader);
}

/** The highlighter, or null while it is still on its way. */
export function loadedHighlighter(): HighlighterCore | null {
    return highlighter;
}

/** Asks for the chunk: one import, however many code blocks ask. */
export function loadHighlighter(): Promise<void> {
    loading ??= import("./shiki-bundle").then((bundle) => {
        highlighter = bundle.highlighter;
        for (const reader of readers) reader();
    });
    return loading;
}

/**
 * The tokens of one code block, by language, or null when they cannot be had: there is no
 * highlighter yet, or the fence named a language it does not know (which covers `text`, an
 * empty fence, and every name no grammar carries).
 */
export function tokensOf(highlighter: HighlighterCore | null, code: string, language: string): CodeToken[][] | null {
    const asked = language.toLowerCase();
    if (highlighter === null || !highlighter.getLoadedLanguages().includes(asked)) return null;

    const key = `${asked}\u0000${code}`;
    const kept = cache.get(key);
    if (kept !== undefined) return kept;

    const { tokens } = highlighter.codeToTokens(code, {
        lang: asked,
        themes: { light: "light-plus", dark: "dark-plus" },
        defaultColor: false,
    });
    const lines: CodeToken[][] = tokens.map((line) =>
        line.map((token) => ({ text: token.content, vars: { ...token.htmlStyle } })),
    );

    cache.set(key, lines);
    if (cache.size > KEPT) {
        for (const oldest of cache.keys()) {
            cache.delete(oldest);
            break;
        }
    }
    return lines;
}
