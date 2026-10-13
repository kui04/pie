/**
 * The highlighter and everything it needs, in one module: `lib/code-highlight.ts` imports it
 * on demand, so the grammars become a chunk of their own and never part of the first load.
 *
 * One line per language. A language left off this list is drawn as plain text like any other
 * the highlighter does not know; these are the ones a model writes most, and together they
 * are the chunk's 2.6 MB (320 KB gzipped).
 */

import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createHighlighterCoreSync } from "shiki/core";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";
import bash from "shiki/langs/bash.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import lua from "shiki/langs/lua.mjs";
import markdown from "shiki/langs/markdown.mjs";
import php from "shiki/langs/php.mjs";
import python from "shiki/langs/python.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";

/**
 * The app's syntax highlighter.
 *
 * Dark+ and Light+ are the colours this app's palette was cut from, so a code block is the
 * same code its editor would show. The JavaScript engine and not oniguruma: it is the one
 * that needs no WASM module, and a block of a few hundred lines is a few milliseconds either
 * way. Built synchronously, so a component can ask it for tokens while it renders - an async
 * one would have to draw the code as plain text first and colour it after.
 */
export const highlighter = createHighlighterCoreSync({
    themes: [darkPlus, lightPlus],
    langs: [
        bash,
        c,
        cpp,
        csharp,
        css,
        diff,
        dockerfile,
        go,
        html,
        ini,
        java,
        javascript,
        json,
        jsx,
        kotlin,
        lua,
        markdown,
        php,
        python,
        ruby,
        rust,
        shellscript,
        sql,
        swift,
        toml,
        tsx,
        typescript,
        xml,
        yaml,
    ],
    engine: createJavaScriptRegexEngine(),
});
