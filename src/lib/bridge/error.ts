/** The module of the failure. Rust has one variant for each module. */
export type PieErrorModule = "connection" | "commands" | "rpc" | "io";

/**
 * The name of the failure, as the layer of the failure writes it. Examples are
 * `auth`, `host_key_rejected`, and `not_absolute`. The name is the name of the
 * variant that failed. Pie does not assign a label.
 *
 * A failure of type `io` has no name. An I/O error has no variants. Its sentence
 * comes from the platform.
 */
export type PieErrorKind = string;

/** The named failure, with the plain data that it carries. */
export interface PieErrorCause {
    kind: PieErrorKind;
    [field: string]: unknown;
}

/**
 * A failure: the module, the sentence from Rust for a person, and the name of
 * the failure.
 */
export interface PieError {
    type: PieErrorModule;
    message: string;
    error?: PieErrorCause;
}

const MODULES: readonly PieErrorModule[] = ["connection", "commands", "rpc", "io"];

/**
 * Whether a failure already has a name of its own.
 *
 * A rejection that is not one of these never reached a command: Rust answered
 * with a message of Tauri's, or the invocation did not leave the webview at all
 * (a command that is not registered, a permission that is missing). The one
 * caller that must tell the difference is `call`, which logs such a failure
 * because nothing else would ever show it.
 */
export function isPieError(thrown: unknown): thrown is PieError {
    if (typeof thrown !== "object" || thrown === null) return false;
    const candidate = thrown as Partial<PieError>;
    if (!MODULES.includes(candidate.type as PieErrorModule)) return false;
    if (typeof candidate.message !== "string") return false;
    if (candidate.error === undefined) return true;
    return typeof candidate.error === "object" && candidate.error !== null && typeof candidate.error.kind === "string";
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
 * error (a missing IPC handler, a malformed payload) has a different shape. A
 * failure that renders as `undefined` is not visible to the person.
 *
 * This function files such a failure under `commands`. That module is the side
 * of the boundary that belongs to pie.
 */
export function asPieError(thrown: unknown): PieError {
    if (isPieError(thrown)) return thrown;
    const message = messageOf(thrown);
    return { type: "commands", message: message === "" ? "pie could not reach its own backend" : message };
}
