import { listen } from "@tauri-apps/api/event";
import { call, type Unsubscribe } from "./invoke";

/**
 * The name of the connection pie opens.
 *
 * The name is the frontend's, because it is what this connection's events are
 * announced under (`pi://connection/{id}/state`), and Rust asks about it before
 * `connect` has returned. One host at a time is what the product needs, so there
 * is exactly one name to choose.
 */
export const CONNECTION_ID = "main";

/**
 * How to authenticate to an SSH host.
 *
 * A key crosses as its own text, never as a path to a file: pie copies no secret
 * material into its own storage, and on Android a picked file is a `content://`
 * URI rather than a path at all. Turning a file into text is the frontend's job,
 * which is what the picker in `pick.ts` does.
 */
export type SshAuthSpec = { type: "password"; password: string } | { type: "key"; key: string; passphrase?: string };

/** What to connect to. */
export type ConnectSpec =
    { transport: "local" } | { transport: "ssh"; host: string; port?: number; user: string; auth: SshAuthSpec };

/** One pi process on the host. */
export interface SessionInfo {
    /** The name its events are announced under. */
    id: string;
    /** Where pi started, when pie chose that. */
    cwd: string | null;
}

/** What `connect` answers with. */
export interface ConnectionInfo {
    id: string;
    /** `local`, or `user@host:port`. */
    endpoint: string;
    sessions: SessionInfo[];
}

/** A host key, in the terms a person can check it in. */
export interface PresentedKey {
    host: string;
    port: number;
    /** Key type, e.g. `ssh-ed25519`. */
    algorithm: string;
    /** OpenSSH-style fingerprint, e.g. `SHA256:9f3k...`. */
    fingerprint: string;
}

/** What the frontend hears about a connection while it is being made. */
export type ConnectionState = { type: "host_key"; key: PresentedKey };

/**
 * Opens a host and starts its first session.
 *
 * The call can be waiting on a person when it is made: a host key that is in no
 * store arrives on {@link onConnectionState} while this promise is still
 * pending, and the answer goes back through {@link trustHostKey}. So the
 * listener has to be running before this is called.
 */
export function connect(id: string, spec: ConnectSpec): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("connect", { id, spec });
}

/**
 * Answers the host-key question the frontend is showing.
 *
 * `connection` is the one being answered, not just a label: a sheet left open by
 * a question nobody answered must not be able to answer the question that
 * replaced it, because the keys it showed are not the ones being asked about.
 *
 * Returns whether a question was actually waiting for this answer — a late one,
 * or one for another connection, answers nothing.
 */
export function trustHostKey(connection: string, trusted: boolean): Promise<boolean> {
    return call<boolean>("trust_host_key", { connection, trusted });
}

/**
 * Listens to `pi://connection/{id}/state` until the returned function is called.
 *
 * Only host-key questions are on this channel today; the connection ending on its
 * own is still Rust's business to report, and arrives with the next command that
 * finds the channel gone.
 */
export function onConnectionState(id: string, onState: (state: ConnectionState) => void): Promise<Unsubscribe> {
    return listen<ConnectionState>(`pi://connection/${id}/state`, (event) => onState(event.payload));
}
