/**
 * The one way out of React.
 *
 * Everything pie's Rust side is asked to do goes through here, and nothing else
 * in `src/` touches `invoke` or the event bus: components render state and call
 * these functions, which is the whole of what React is allowed to know about the
 * outside (see `.agents/rules/architecture.md`).
 *
 * One file per area, and none of them mixes two: [`composer`] says what the
 * person wants a session to do, [`connect`] is the one host that pie holds,
 * [`session`] is one session of pi (its reads, the switch between its
 * conversations, the sessions of the host, and what it says while it runs),
 * [`open`] / [`pick`] / [`platform`] carry one command each, and [`error`] /
 * [`invoke`] are the machinery of this layer itself. Import from this file.
 *
 * The types mirror what `src-tauri/src/commands/` and `src-tauri/src/connection/`
 * accept and return. They are hand-written, so a change on the Rust side has to be
 * made here too — Rust is the authority and the mirror follows it.
 */

export * from "./composer";
export * from "./connect";
export * from "./error";
export * from "./invoke";
export * from "./open";
export * from "./pick";
export * from "./platform";
export * from "./session";
export * from "./window";
