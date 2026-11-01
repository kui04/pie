/**
 * The files of the machine pie runs on: what a dialog picks, and what one pick
 * holds.
 *
 * The mirror of `src-tauri/src/commands/filesystem.rs`. A pick is text: a path on
 * a desktop, or an absolute URL on Android (`content://`). Rust decides which one a
 * text is, so this side passes the text through unchanged.
 */

import { call } from "./invoke";

/**
 * The text one pick answered.
 *
 * It stays text because only Rust can say whether it names a path or a URL, and a
 * refusal there is a `PieError` with a sentence for a person.
 */
export type PickedText = string;

/** One extension filter of the file dialog. */
export interface DialogFilter {
    /** What the filter is for, such as `Private keys`. */
    name: string;
    /** Extensions without the dot. */
    extensions: string[];
}

/** How the file dialog behaves. */
export interface SelectOptions {
    /** The title of the dialog. */
    title?: string;
    /** Whether more than one file can be chosen. */
    multiple?: boolean;
    /** Pick a directory instead of a file. Mobile has no such picker. */
    directory?: boolean;
    filters?: DialogFilter[];
}

/** What one file or directory of this machine is. */
export interface FileMetadata {
    /** The path, as this machine writes it. */
    path: string;
    /** The MIME type Rust inferred from the content. */
    mimeType: string;
    size: number;
    isFile: boolean;
    isDir: boolean;
    isSymlink: boolean;
    readonly: boolean;
    /** The creation time, or `null` when the platform keeps none. */
    created: string | null;
    modified: string | null;
}

/** The content of one file of this machine. */
export type FileContent =
    { type: "image"; mimeType: string; base64: string } | { type: "text"; mimeType: string; content: string };

/**
 * Makes a directory of this machine, with parents as needed.
 *
 * A URL names no directory that pie creates, so Android answers `bad_argument` for
 * one.
 */
export function createLocalDirAll(path: PickedText): Promise<void> {
    return call<void>("create_local_dir_all", { path });
}

/** Reads one file of this machine. */
export function read(path: PickedText): Promise<FileContent> {
    return call<FileContent>("read", { path });
}

/** Reads what one path of this machine is. A URL has no metadata: it is refused. */
export function readMetadata(path: PickedText): Promise<FileMetadata> {
    return call<FileMetadata>("read_metadata", { path });
}

/**
 * Opens the system dialog and answers what a person picked, or `null` when they
 * cancelled.
 *
 * Each answer is the text of one pick, which {@link read} and {@link readMetadata}
 * take next.
 */
export function selectFiles(options?: SelectOptions): Promise<string[] | null> {
    return call<string[] | null>("select_files", { options });
}
