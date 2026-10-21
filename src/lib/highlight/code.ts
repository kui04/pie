import type { LanguageRegistration } from "shiki";
import type { HighlighterCore } from "shiki/core";

/**
 * The app's syntax colours, loaded in pieces: `shiki` and the common grammars arrive when the
 * first code block is drawn, and a rarer grammar is fetched when a fence names it. Until a
 * piece lands, a block is plain text (`rules/frontend.md` forbids a highlighter in the initial
 * load).
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

/** The languages the loaded highlighter carries, read once when its chunk lands. */
let languages: Set<string> | null = null;

/** Bumped when the chunk or an on-demand grammar arrives, so a reader redraws. */
let revision = 0;

/** How often a language is loaded once, even when many blocks ask for it. */
const loadingLanguages = new Map<string, Promise<void>>();

/** The grammars held back from the common chunk, by the name a fence may use. */
const OPTIONAL = {
    c: "c",
    cpp: "cpp",
    "c++": "cpp",
    csharp: "csharp",
    cs: "csharp",
    "c#": "csharp",
    html: "html",
    dockerfile: "dockerfile",
    docker: "dockerfile",
    go: "go",
    ini: "ini",
    properties: "ini",
    yaml: "yaml",
    yml: "yaml",
    java: "java",
    kotlin: "kotlin",
    kt: "kotlin",
    kts: "kotlin",
    lua: "lua",
    php: "php",
    ruby: "ruby",
    rb: "ruby",
    rust: "rust",
    rs: "rust",
    sql: "sql",
    swift: "swift",
    toml: "toml",
    xml: "xml",
} as const;

type OptionalLanguage = (typeof OPTIONAL)[keyof typeof OPTIONAL];

const LOADERS: Record<OptionalLanguage, () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>> = {
    c: () => import("shiki/langs/c.mjs"),
    cpp: () => import("shiki/langs/cpp.mjs"),
    csharp: () => import("shiki/langs/csharp.mjs"),
    dockerfile: () => import("shiki/langs/dockerfile.mjs"),
    html: () => import("shiki/langs/html.mjs"),
    go: () => import("shiki/langs/go.mjs"),
    ini: () => import("shiki/langs/ini.mjs"),
    java: () => import("shiki/langs/java.mjs"),
    kotlin: () => import("shiki/langs/kotlin.mjs"),
    lua: () => import("shiki/langs/lua.mjs"),
    php: () => import("shiki/langs/php.mjs"),
    ruby: () => import("shiki/langs/ruby.mjs"),
    rust: () => import("shiki/langs/rust.mjs"),
    sql: () => import("shiki/langs/sql.mjs"),
    swift: () => import("shiki/langs/swift.mjs"),
    toml: () => import("shiki/langs/toml.mjs"),
    xml: () => import("shiki/langs/xml.mjs"),
    yaml: () => import("shiki/langs/yaml.mjs"),
};

/** Told when the highlighter arrives: what `useSyncExternalStore` subscribes to. */
export function subscribeToHighlighter(reader: Reader): () => void {
    readers.add(reader);
    return () => readers.delete(reader);
}

/** The highlighter, or null while it is still on its way. */
export function loadedHighlighter(): HighlighterCore | null {
    return highlighter;
}

/** The revision of the highlighter: the chunk, and each grammar loaded after it. */
export function highlighterVersion(): number {
    return revision;
}

/** Asks for the chunk: one import, however many code blocks ask. */
export function loadHighlighter(): Promise<void> {
    loading ??= import("./shiki")
        .then((bundle) => {
            highlighter = bundle.highlighter;
            languages = new Set(highlighter.getLoadedLanguages());
            revision += 1;
            for (const reader of readers) reader();
        })
        .catch((thrown: unknown) => {
            // A failed chunk is not fatal: a later block asks again.
            loading = null;
            throw thrown;
        });
    return loading;
}

/** Loads one grammar that the common chunk does not carry, once. */
export function ensureLanguage(language: string): Promise<void> {
    const asked = language.toLowerCase();
    if (highlighter === null) return loadHighlighter().then(() => ensureLanguage(asked));
    if (languages?.has(asked)) return Promise.resolve();

    const canonical = OPTIONAL[asked as keyof typeof OPTIONAL];
    if (canonical === undefined) return Promise.resolve();

    const pending = loadingLanguages.get(canonical);
    if (pending !== undefined) return pending;

    const load = LOADERS[canonical]()
        .then((module) => {
            highlighter?.loadLanguageSync(module.default);
            languages = new Set(highlighter?.getLoadedLanguages() ?? []);
            revision += 1;
            for (const reader of readers) reader();
        })
        .finally(() => loadingLanguages.delete(canonical));
    loadingLanguages.set(canonical, load);
    return load;
}

/**
 * The tokens of one code block, by language, or null when they cannot be had: there is no
 * highlighter yet, or the fence named a language it does not know (which covers `text`, an
 * empty fence, and every name no grammar carries).
 */
export function tokensOf(highlighter: HighlighterCore | null, code: string, language: string): CodeToken[][] | null {
    const asked = language.toLowerCase();
    if (highlighter === null) return null;

    // A block already read is answered before the language lookup: a screen with many
    // unchanged blocks would otherwise rebuild the language list on every render.
    const key = `${asked}\u0000${code}`;
    const kept = cache.get(key);
    if (kept !== undefined) return kept;

    languages ??= new Set(highlighter.getLoadedLanguages());
    if (!languages.has(asked)) return null;

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
