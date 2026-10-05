import { listen } from "@tauri-apps/api/event";
import { call, type Unsubscribe } from "./invoke";

/**
 * The name of the connection that pie opens.
 *
 * The frontend selects this name. The events of the connection use this name.
 * Rust asks for the name before `connect` returns. The product keeps one host at
 * a time, so one name is sufficient.
 */
export const CONNECTION_ID = "main";

/**
 * How to authenticate to an SSH host.
 *
 * A key goes as text. A key never goes as a path to a file. Pie copies no secret
 * into its own storage. On Android, the picker returns a `content://` URI, not a
 * path. `pick.ts` reads the file through Rust.
 */
export type SshAuthSpec = { type: "password"; password: string } | { type: "key"; key: string; passphrase?: string };

/** What to connect to. */
export type ConnectSpec =
    { transport: "local" } | { transport: "ssh"; host: string; port?: number; user: string; auth: SshAuthSpec };

/** One pi process on the host. */
export interface SessionInfo {
    /** The id its events are announced under. */
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

/** A host key. A person compares these values with the values of the host. */
export interface PresentedKey {
    host: string;
    port: number;
    /** Key type, e.g. `ssh-ed25519`. */
    algorithm: string;
    /** OpenSSH-style fingerprint, e.g. `SHA256:9f3k...`. */
    fingerprint: string;
}

/** What the frontend hears about a connection during the handshake. */
export type ConnectionState = { type: "host_key"; key: PresentedKey };

/**
 * Opens a host. Starts the first session of the host.
 *
 * A host key that is in no store arrives on {@link onConnectionState} while this
 * promise is pending. The answer goes back through {@link trustHostKey}. The
 * listener must start before this function is called.
 */
export function connect(id: string, spec: ConnectSpec): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("connect", { id, spec });
}

/**
 * Answers the host-key question that the frontend shows.
 *
 * `connection` receives the answer. Do not use it as a label only. A sheet that
 * stays open after an unanswered question must not answer the new question. The
 * person did not see the keys of the new question.
 *
 * Returns whether a question waited for this answer. A late answer, or an answer
 * for another connection, answers no question.
 */
export function trustHostKey(connection: string, trusted: boolean): Promise<boolean> {
    return call<boolean>("trust_host_key", { connection, trusted });
}

/**
 * Listens to `pi://connection/{id}/state` until the returned function is called.
 *
 * Today, this channel carries host-key questions only. If the connection ends,
 * the next command that finds it gone reports the end.
 */
export function onConnectionState(id: string, onState: (state: ConnectionState) => void): Promise<Unsubscribe> {
    return listen<ConnectionState>(`pi://connection/${id}/state`, (event) => onState(event.payload));
}
