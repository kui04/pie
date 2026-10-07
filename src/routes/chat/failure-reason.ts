/**
 * The words of the workspace for the failures it can meet.
 *
 * A module of its own because two components of this screen read it: the transcript,
 * and the session drawer beside it. Rust holds it against its own enums
 * (`tests/failure_kinds.rs`).
 */

import type { FailureText } from "@/lib/failure-text";

export const FAILURE_REASON: FailureText = {
    // `connection::Error`: which session a screen asked for, and what it did with
    // the answer. The last four are the session drawer's own failures: its listing
    // of the host, and the switch to another conversation.
    unknown_session: "That session is gone from this connection. Connect again.",
    not_connected: "There is no connection.",
    unreadable_local: "The sessions on this machine could not be read.",
    unreadable_remote: "The sessions on the host could not be read.",
    sftp_unanswered: "The host would not open a channel to read files through.",
    not_absolute: "That is not a path on the host.",
    // `pi_rpc::Error`: the reads behind the transcript.
    closed: "The connection to pi ended.",
    timeout: "pi did not answer in time.",
    rpc: "pi refused the command.",
    payload: "pi answered in a way pie does not know.",
    io: "The connection to pi failed.",
    no_runtime: "Pie could not reach its own runtime.",
    // `commands::Error`: the IPC layer itself.
    unusable_name: "That name cannot be used for a connection.",
    no_host_key_store: "Pie cannot find where to keep host keys.",
    unopenable_url: "That link is not one pie opens.",
    open_failed: "The machine would not open that link.",
};
