/**
 * The highlighter and everything it needs, in one module: `lib/highlight/code.ts` imports it
 * on demand, so the grammars become a chunk of their own and never part of the first load.
 *
 * One line per common language. The rest are loaded on demand by `code-highlight.ts` when
 * a fence names one, so this chunk holds only the grammars most conversations use.
 */

import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createHighlighterCoreSync } from "shiki/core";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";

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
    langs: [bash, css, diff, javascript, json, jsx, markdown, python, shellscript, tsx, typescript],
    engine: createJavaScriptRegexEngine(),
});
