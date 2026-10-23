/**
 * What a failure from Rust looks like on this side of the boundary.
 *
 * A command answers a failure as one object: `kind` is the name the boundary gave
 * it, `message` is the sentence a person reads, and the fields of a named failure
 * travel beside them. `kind` is `failed` for every failure that has no name of its
 * own: a machine, a program, or the protocol. The sentence is the whole report;
 * the name is there for the one place that must tell failures apart.
 */

/**
 * The name of a failure: the boundary writes it, or this side files a failure
 * that never reached a command as `unreached`.
 */
export type PieErrorKind = string;

/**
 * A failure: the name the boundary gave it, the sentence for a person, and the
 * plain fields of a named failure (`doing`, `reason`, `url`, ...).
 */
export interface PieError {
    kind: PieErrorKind;
    message: string;
    [field: string]: unknown;
}

/**
 * The kind of a failure that never reached a pie command.
 *
 * Tauri rejects with its own failure - a command that is not registered, an
 * argument of the wrong shape, a permission that is missing - and Rust never
 * wrote a sentence for it. It is filed as this, so a screen still has a sentence
 * to show.
 */
const UNREACHED = "unreached";

/**
 * Whether a failure is one that the boundary wrote.
 *
 * A failure of Tauri itself is a string, or an object without these two fields.
 * Therefore the shape is what tells the two apart: a message that arrives as an
 * object is one that a pie command answered.
 */
export function isPieError(thrown: unknown): thrown is PieError {
    if (typeof thrown !== "object" || thrown === null) return false;
    const candidate = thrown as Partial<PieError>;
    return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

/**
 * The sentence that a person can read from an unknown failure.
 *
 * Tauri rejects with a string for its own failures. A bare object with no
 * `message` would reach the toast as `[object Object]`.
 */
function messageOf(thrown: unknown): string {
    if (typeof thrown === "string") return thrown;
    if (typeof thrown === "object" && thrown !== null && "message" in thrown) {
        const message: unknown = thrown.message;
        if (typeof message === "string") return message;
    }
    return "";
}

/**
 * Reads what came back over the boundary as a [`PieError`].
 *
 * This function checks the shape. It does not trust the shape. A Tauri-side
 * failure (a missing IPC handler, a malformed payload) has a different shape. A
 * failure that renders as `undefined` is not visible to the person.
 */
export function asPieError(thrown: unknown): PieError {
    if (isPieError(thrown)) return thrown;
    const message = messageOf(thrown);
    return { kind: UNREACHED, message: message === "" ? "pie could not reach its own backend" : message };
}
