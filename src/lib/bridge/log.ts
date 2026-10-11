/**
 * What the frontend writes into the log.
 *
 * The webview has no log anybody can read: the desktop one is behind a
 * developer tool nobody opens, and on Android there is nothing to open at all.
 * So a line goes to Rust (`log` of `src-tauri/src/commands/log.rs`) and leaves
 * through the same subscriber as everything else - stderr on the desktop,
 * logcat on Android - under the one target `pie_ui`.
 *
 * Which lines are worth sending is Rust's answer, not ours: the filter is
 * `RUST_LOG`'s, so the frontend asks once (`log_levels`) and then keeps quiet
 * about the levels that are off. That is what makes a `debug` line in a hot path
 * - a record arriving while a run streams - cost nothing when nobody asked for
 * it.
 *
 * A line that Rust cannot take is dropped, after one `console.debug` saying so:
 * outside the app (a browser, Storybook) there is no log to write into, and
 * logging is never a failure path of its own.
 *
 * It is the one file of this layer that calls `invoke` itself rather than
 * `call`: a log line has no caller to reject to, so the mapping to a
 * [`PieError`](./error.ts) that `call` exists for would be dead weight - and
 * `call` logs a rejection it cannot name, which would make these two modules
 * depend on each other.
 */

import { invoke } from "@tauri-apps/api/core";

/** How important a line is. Mirrors `LogLevel` on the Rust side. */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/**
 * What a line is about.
 *
 * The values are serialized as JSON, so a field is what a reader can search for:
 * a string, a number, a boolean. An `Error` serializes to `{}` - send
 * `error.message` instead, which is what `asPieError(...).message` gives.
 */
export type LogFields = Record<string, unknown>;

/** Which levels Rust keeps. Mirrors `LogLevels` on the Rust side. */
export type LogLevels = Record<LogLevel, boolean>;

/** Rust's answer, once. Until it arrives, every line is sent. */
let kept: LogLevels | null = null;

/** The one question in flight, so that a hundred lines ask it once. */
let asking: Promise<void> | null = null;

/** The one notice that logging is not reaching Rust, so it is said once. */
let warned = false;

/**
 * The five ways a line is written.
 *
 * `log.error("the read failed", { reason })` rather than a level spelled by the
 * caller: the level of a line is decided where the line is written, and a string
 * that must be spelled right is a string that can be spelled wrong.
 */
export const log = {
    /** Something broke. */
    error: (message: string, fields?: LogFields): void => write("error", message, fields),
    /** Something is worth knowing now, but did not break. */
    warn: (message: string, fields?: LogFields): void => write("warn", message, fields),
    /** A step of the app the reader would want in a report. */
    info: (message: string, fields?: LogFields): void => write("info", message, fields),
    /** A step of the app that only matters when something is wrong. */
    debug: (message: string, fields?: LogFields): void => write("debug", message, fields),
    /** Everything, including what only a trace of one bug needs. */
    trace: (message: string, fields?: LogFields): void => write("trace", message, fields),
};

/** Writes one line, if Rust keeps lines of its level. */
function write(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (kept === null && asking === null) asking = ask();

    if (kept !== null && !kept[level]) return;

    void invoke("log", { line: { level, message, fields } }).catch(() => {
        if (warned) return;

        warned = true;
        console.debug("pie's log is not reaching Rust; the lines of the frontend go nowhere", message);
    });
}

/** Asks Rust which levels it keeps, and remembers the answer. */
async function ask(): Promise<void> {
    kept = await invoke<LogLevels>("log_levels").catch(() => null);
}
