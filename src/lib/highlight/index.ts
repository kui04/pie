/**
 * The code highlighter and its on-demand grammars.
 *
 * The chunk itself stays out of this barrel: importing it is what makes it load, and
 * only `code.ts` asks for it when the first code block is drawn.
 */

export * from "./code";
