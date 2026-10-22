/**
 * The one way out of React.
 *
 * Everything pie's Rust side is asked to do goes through here, and nothing else
 * in `src/` touches `invoke` or the event bus: components render state and call
 * these functions, which is the whole of what React is allowed to know about the
 * outside (see `.agents/rules/architecture.md`).
 *
 * One file for each area of the product, and each one mirrors the file of the
 * same name in `src-tauri/src/commands/`: [`host`] is the one machine that pie
 * holds, [`session`] is one session of pi (its reads, its conversations, and what
 * it says while it runs), [`app`] is the app itself, [`files`] is what a person
 * selects with a system dialog or stages for attachments, [`log`] is where a line
 * of the frontend goes, and [`error`] / [`invoke`] are the machinery of this
 * layer. Import from this file.
 *
 * The types mirror what `src-tauri/src/commands/` and `src-tauri/src/host/` accept
 * and return. They are hand-written, so a change on the Rust side has to be made
 * here too — Rust is the authority and the mirror follows it.
 */

export * from "./app";
export * from "./error";
export * from "./files";
export * from "./host";
export * from "./invoke";
export * from "./log";
export * from "./session";
