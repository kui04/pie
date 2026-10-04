/** How a failure is classified on the way across the boundary. */
export type PieErrorTag =
    "transport" | "auth" | "host_key" | "process" | "rpc" | "already_connected" | "not_connected" | "internal";

/** A failure, kept as a category plus the message Rust wrote for a person. */
export interface PieError {
    type: PieErrorTag;
    message: string;
}

const TAGS: readonly PieErrorTag[] = [
    "transport",
    "auth",
    "host_key",
    "process",
    "rpc",
    "already_connected",
    "not_connected",
    "internal",
];

/**
 * Sorts whatever came back over the boundary into a [`PieError`].
 *
 * Rust rejects with the serialized `PieError`, so the shape is normally already
 * right. It is checked rather than trusted because the alternative is a failure
 * rendered as `undefined`: a Tauri-side error (a missing IPC handler, a
 * malformed payload) arrives in some other shape, and the UI still has to be
 * able to show that something went wrong.
 */
export function asPieError(thrown: unknown): PieError {
    if (
        typeof thrown === "object" &&
        thrown !== null &&
        "type" in thrown &&
        "message" in thrown &&
        TAGS.includes((thrown as PieError).type) &&
        typeof (thrown as PieError).message === "string"
    ) {
        return thrown as PieError;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { type: "internal", message: message === "" ? "pie could not reach its own backend" : message };
}
