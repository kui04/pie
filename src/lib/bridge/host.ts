/**
 * One machine: the reach to it, its directories, its conversations, and the files
 * pie stages on it.
 *
 * The mirror of `src-tauri/src/commands/host.rs`. A connection is named by a
 * {@link HostId} that this side picks, and every command of a connection carries
 * that name. {@link CONNECTION_ID} is the one name the product uses: pie holds one
 * machine at a time.
 *
 * A conversation is named by its file on that machine, not by an id of pie. Two
 * machines can hold the same path, so a name of a conversation is always a
 * {@link HostId} and a path together.
 */

import { listen } from "@tauri-apps/api/event";
import { onAsk, type AskEnvelope } from "./ask";
import { call, type Unsubscribe } from "./invoke";

/** The name of the machine pie connects to. */
export const CONNECTION_ID = "main";

/** The name of one connection. This side picks it. */
export type HostId = string;

/**
 * How pie authenticates to an SSH machine.
 *
 * A key goes as text, never as a path to a file: pie copies no secret into its own
 * storage. On Android the picker answers a `content://` URL, which
 * {@link ../filesystem.read} turns into text first.
 *
 * These three shapes are how Rust spells the credential, and the field names stay
 * snake_case for that reason.
 */
export type HostAuth = "None" | { Password: string } | { Key: { private_key: string; passphrase: string | null } };

/** The machine of an SSH target: a domain name, or an address. */
export type HostName = { domain: string } | { ip: string };

/**
 * An SSH target's machine and port.
 *
 * `port` of `null` is 22. The domain is checked by Rust, so an invalid one is a
 * refusal and not a failed dial.
 */
export interface HostAddress {
    host: HostName;
    port: number | null;
}

/** Where and how pie reaches a machine. */
export type HostTarget = { transport: "local" } | { transport: "ssh"; user: string; host: HostAddress; auth: HostAuth };

/**
 * How a conversation is named, and who named it.
 *
 * A person may name a conversation, and pi may derive one from the first thing a
 * person asked. The two look the same on screen and differ on rename, so the
 * difference is a variant.
 */
export type SessionTitle = { type: "named"; name: string } | { type: "from_first_prompt" } | { type: "untitled" };

/** One conversation of a machine, as the catalog read its file. */
export interface SessionInfo {
    /** pi's own id for the conversation. It names no session of pie: the file does. */
    id: string;
    /** Where the conversation started, or `null` for a file older than that field. */
    cwd: string | null;
    /** The file that names this conversation. */
    path: string;
    title: SessionTitle;
    /** The conversation this one forked from, when it did. */
    parentPath: string | null;
    /** When pi created the conversation. */
    createdAt: string;
    /** When the file last grew. The listing is ordered by it. */
    modifiedAt: string;
    /** The first words of a person, when the file goes that far. */
    firstPrompt: string | null;
}

/** The machine, the conversations that run on it now, and whether the reach is open. */
export interface ConnectionInfo {
    id: HostId;
    /** The conversations that have a pi process now. */
    sessions: SessionInfo[];
    /** Whether the reach to the machine is still open. */
    open: boolean;
}

/** One row of the directory picker. */
export interface DirEntry {
    name: string;
    /** The whole path, as the machine writes it. */
    path: string;
    isDir: boolean;
}

/** One directory level of a machine, with the directory that was read. */
export interface Listing {
    directory: string;
    entries: DirEntry[];
}

/** Where the file to stage comes from. */
export type UploadSource = { type: "local"; path: string } | { type: "in_memory"; name: string; content: number[] };

/** The transfer state of a staged file. */
export type UploadStatus =
    | { type: "uploaded_fresh" }
    | { type: "resumed"; offset: number }
    | { type: "skipped_duplicate"; existingRemotePath: string };

/** What staging one file answered. */
export interface UploadReceipt {
    /** The BLAKE3 digest of the file: 32 bytes. */
    hash: number[];
    /** Where the file waits for pi on the machine. */
    remotePath: string;
    totalBytes: number;
    bytesTransferred: number;
    status: UploadStatus;
}

/** How far one upload has gone. Reported while the file travels, never as the answer. */
export interface UploadProgress {
    bytes: number;
    total: number;
}

/** A host key that no store knows. A person compares these values with the machine. */
export interface TrustAsk {
    /** The connection the question belongs to. */
    host: HostId;
    /** The machine, written `host` or `host:port` as the key file writes it. */
    endpoint: string;
    /** The key type the machine offers, such as `ssh-ed25519`. */
    algorithm: string;
    /** The SHA-256 fingerprint a person can compare with the machine itself. */
    fingerprint: string;
}

/** The person's answer to one host-key question. */
export type TrustAnswer = { type: "trusted" } | { type: "refused" };

/**
 * Reaches a machine and registers the connection under `id`.
 *
 * No pi starts here. A conversation starts a pi when it is attached, so a machine
 * that is only browsed runs no pi.
 *
 * An unknown host key arrives on {@link onTrustAsk} while this promise is pending.
 * Therefore the listener must be attached before this call, and
 * {@link ../ask.readyForAnswer} must have run.
 */
export function connect(id: HostId, target: HostTarget): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("connect", { id, target });
}

/**
 * Reads the connection held under `id` and the conversations that run on it.
 */
export function getConnection(id: HostId): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("connection_info", { id });
}

/**
 * Reaches the machine of a connection that ended, with the credential that Rust
 * already holds.
 *
 * No secret crosses this boundary a second time. A connection that is still open
 * answers itself, so a redundant call is not an error.
 */
export function reconnect(id: HostId): Promise<ConnectionInfo> {
    return call<ConnectionInfo>("reconnect", { id });
}

/**
 * Ends a connection: every pi of it stops, and the conversation files stay where
 * pi wrote them.
 */
export function disconnect(id: HostId): Promise<void> {
    return call<void>("disconnect", { id });
}

/** What the frontend hears about the reach to one machine. */
export type ConnectionState = { type: "open"; host: HostId } | { type: "ended"; host: HostId };

/**
 * Listens to the reach of every connection until the returned function is called.
 *
 * This is the only news of a link that goes away while nothing is being asked. An end
 * that pie itself asked for is not announced: the caller that asked already knows.
 */
export function onConnectionState(onState: (state: ConnectionState) => void): Promise<Unsubscribe> {
    return listen<ConnectionState>("pi://connection/state", (event) => onState(event.payload));
}

/**
 * Starts pi on an existing conversation, and answers the conversation it serves.
 *
 * `session` is a path of that machine, as {@link listSessions} wrote it. Two
 * callers that attach one file at once get one pi: the second process is ended and
 * the first conversation answers.
 */
export function attachSession(id: HostId, session: string): Promise<SessionInfo> {
    return call<SessionInfo>("attach_session", { id, session });
}

/**
 * Starts pi on a new conversation in a directory of the machine.
 *
 * pi chooses the conversation file, so the answer carries the path every later
 * call names.
 */
export function startNewSession(id: HostId, cwd: string): Promise<SessionInfo> {
    return call<SessionInfo>("start_new_session", { id, cwd });
}

/** Ends one pi. The conversation file stays where pi wrote it. */
export function detachSession(id: HostId, session: string): Promise<void> {
    return call<void>("detach_session", { id, session });
}

/** Deletes one conversation file of the machine, and ends its pi first when one runs. */
export function deleteSession(id: HostId, session: string): Promise<void> {
    return call<void>("delete_session", { id, session });
}

/** Every conversation of the machine, newest first. */
export function listSessions(id: HostId): Promise<SessionInfo[]> {
    return call<SessionInfo[]>("list_sessions", { id });
}

/** Makes a directory of the machine, with parents as needed. */
export function createDirAll(id: HostId, path: string): Promise<void> {
    return call<void>("create_dir_all", { id, path });
}

/** Whether a path names a directory on the machine. */
export function dirExists(id: HostId, path: string): Promise<boolean> {
    return call<boolean>("dir_exists", { id, path });
}

/**
 * The login home of the machine, or `null` when it reports none.
 *
 * A machine with no home is not a failure: pie asks so it can start a picker
 * somewhere.
 */
export function homeDir(id: HostId): Promise<string | null> {
    return call<string | null>("home_dir", { id });
}

/**
 * One directory level of the machine, for the picker.
 *
 * `path` is an absolute path of that machine. Rust refuses a relative one, and the
 * rows carry their whole paths, so the picker never builds one.
 */
export function listDirs(id: HostId, path: string): Promise<Listing> {
    return call<Listing>("list_dirs", { id, path });
}

/**
 * Stages one file where pi on the machine can read it.
 *
 * The answer is the receipt. Progress travels on [`onUploadProgress`], and its
 * reports are bytes: a percentage is the screen's business.
 */
export function uploadFile(id: HostId, uploadId: string, source: UploadSource): Promise<UploadReceipt> {
    return call<UploadReceipt>("upload_file", { id, uploadId, source });
}

/** Listens to the progress of one upload until the returned function is called. */
export function onUploadProgress(
    uploadId: string,
    onProgress: (progress: UploadProgress) => void,
): Promise<Unsubscribe> {
    return listen<UploadProgress>(`pi://upload/${uploadId}`, (event) => onProgress(event.payload));
}

/**
 * Listens to host-key questions until the returned function is called.
 *
 * The answer goes back through {@link ../ask.answer} with the id of the envelope:
 * `{ type: "trusted" }` records the key, and `{ type: "refused" }` fails the
 * connect.
 */
export function onTrustAsk(onRequest: (request: AskEnvelope<TrustAsk>) => void): Promise<Unsubscribe> {
    return onAsk<TrustAsk>("pi://ask/host_key", onRequest);
}
