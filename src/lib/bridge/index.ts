/**
 * The one way out of React.
 *
 * Everything pie's Rust side is asked to do goes through here, and nothing else in
 * `src/` touches `invoke` or the event bus: components render state and call these
 * functions, which is the whole of what React is allowed to know about the outside
 * (see `.agents/rules/architecture.md`).
 *
 * The files mirror `src-tauri/src/` one for one: [`app`], [`filesystem`], [`host`],
 * [`log`] and [`session`] are `commands/`, [`ask`] is `bus.rs` (the questions Rust
 * puts and waits on), and [`error`] is `error.rs`. [`invoke`] is the Tauri call
 * every command goes through. Import from this file.
 *
 * The types are hand-written mirrors: a change on the Rust side has to be made here
 * too, because Rust is the authority.
 */

export * from "./app";
export * from "./ask";
export * from "./error";
export * from "./filesystem";
export * from "./host";
export * from "./invoke";
export * from "./log";
export * from "./session";
