/**
 * The one machine pie is connected to: reaching it, reading its directories, and
 * leaving it.
 *
 * The mirror of `src-tauri/src/commands/host.rs`. The name of the connection is
 * the frontend's own [`CONNECTION_ID`]: Rust asks for it before `connect`
 * returns, and the events of the connection carry it.
 *
 * One question travels the other way while `connect` is pending: an unknown host
 * key. It arrives on {@link onConnectionState}, and the answer goes back through
 * {@link trustHostKey}.
 */

import { listen } from "@tauri-apps/api/event";
import { call, type Unsubscribe } from "./invoke";

/**
 * The name of the connection that pie opens.
 *
 * The frontend selects this name. The events of the connection use this name.
 * Rust asks for the name before `connect` returns. The product keeps one machine
 * at a time, so one name is sufficient.
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

/** One pi process on the machine. */
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
    /**
     * Whether the reach to the machine is still open.
     *
     * A connection that ended is still the one Rust holds, so the answer being there says
     * nothing about the link. A read that failed against the reach asks again, and this is
     * what the answer says: the failure itself is not a verdict, because it can have another
     * reason.
     */
    open: boolean;
}

/** One row of the directory picker: a name, the whole path, and whether it is a directory. */
export interface DirEntry {
    name: string;
    path: string;
    isDir: boolean;
}

/**
 * One directory level of a machine, with the directory it is. The directory comes
 * back with the rows because pie cannot name the home directory of a machine by
 * itself: it asks for no path, and the machine answers with its own.
 */
export interface Listing {
    /** The directory that was read, as the host writes it. */
    directory: string;
    entries: DirEntry[];
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

/** What the frontend hears about a connection. */
export type ConnectionState =
    | { type: "host_key"; key: PresentedKey }
    /** The reach to the machine ended, and the connection is still pie's. Nothing on it
     * answers any more, and nothing else announces it: no command need be in flight when
     * a network goes away. */
    | { type: "ended" };

/**
 * Opens a machine: the reach to it, and the conversations it holds.
 *
 * No pi starts here. A session is a pi process, and the workspace starts one with
 * `attachSession` when it needs to speak, so a machine that is only browsed runs
 * no pi.
 *
 * A host key that is in no store arrives on {@link onConnectionState} while this
 * promise is pending. The answer goes back through {@link trustHostKey}. The
 * listener must start before this function is called.
 */
export function connect(id: string, spec: ConnectSpec): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("connect", { id, spec });
}

/**
 * What pie holds about its one connection, or `null` when there is none.
 *
 * The machine that opened the connection dies with the connect screen. The
 * workspace reads the session it subscribes to from here instead. Rust holds the
 * connection, so a reload of the webview reads the same answer.
 */
export function getConnection(): Promise<ConnectionInfo | null> {
    return call<ConnectionInfo | null>("get_connection");
}

/**
 * Brings the connection back, with what Rust already holds.
 *
 * The machine, the address and the credential are the ones of the connection that ended,
 * which Rust kept in its own memory: no secret crosses this boundary a second time, and a
 * person types nothing again. Answers the new connection, or the reason a dial failed.
 */
export function reconnect(): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("reconnect");
}

/**
 * Ends the connection: every session of pi stops, and the files of those
 * sessions stay where pi wrote them.
 *
 * A disconnect with no connection does nothing, so a click that races the end of
 * a connection is not an error.
 */
export function disconnect(): Promise<void> {
    return call<void>("disconnect");
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

/** Returns the login home directory of the connected machine, if known. */
export function homeDir(): Promise<string | null> {
    return call<string | null>("home_dir");
}

/**
 * One directory level on the connected machine, for the directory picker.
 *
 * `path` is an absolute path on that machine: pie resolves no relative path
 * against its own directory, and the rows carry their whole paths, so the
 * picker never builds one.
 */
export function listDirs(path: string): Promise<Listing> {
    return call<Listing>("list_dirs", { path });
}

/**
 * Whether a path names a directory on the connected machine.
 *
 * The picker asks this when the typed text matches nothing: a name that
 * stands is entered, a name that does not is offered for making.
 */
export function dirExists(path: string): Promise<boolean> {
    return call<boolean>("dir_exists", { path });
}

/**
 * Makes a directory on the connected machine, with parents as needed.
 *
 * The picker offers this when the typed path names nothing: the confirm names
 * the path, and this makes it. `path` is an absolute path on that machine.
 */
export function createDir(path: string): Promise<void> {
    return call<void>("create_dir", { path });
}

/**
 * Listens to `pi://connection/{id}/state` until the returned function is called.
 *
 * This channel carries two things that no command reports: a host-key question during a
 * handshake, and the end of the reach to the machine. A lost reach is not a failed
 * command - the link is gone while nothing is being asked - so the app keeps one listener
 * for the whole run of the window.
 */
export function onConnectionState(id: string, onState: (state: ConnectionState) => void): Promise<Unsubscribe> {
    return listen<ConnectionState>(`pi://connection/${id}/state`, (event) => onState(event.payload));
}
