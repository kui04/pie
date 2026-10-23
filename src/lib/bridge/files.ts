/**
 * File dialog selection and path inspection.
 *
 * The mirror of `src-tauri/src/commands/files.rs`.
 */

import type { ImageContent } from "@/lib/rpc-protocol";
import { call } from "./invoke";

/**
 * Filter for file extensions in system dialogs.
 */
export interface DialogFilter {
    /** Filter description shown in dialog (e.g. "Private keys", "Images"). */
    name: string;
    /** Extension strings without dots (e.g. ["pem", "key"]). */
    extensions: string[];
}

/**
 * Target type for the system selection dialog.
 */
export type SelectTarget = "file" | "folder";

/**
 * Configuration options for opening a native file or folder selection dialog.
 */
export interface SelectOptions {
    /** Window title of the dialog. */
    title?: string;
    /** Whether multiple items can be chosen. */
    multiple?: boolean;
    /** Target item type: file or folder. */
    target?: SelectTarget;
    /** File extension filters. */
    filters?: DialogFilter[];
}

/**
 * One image that a person selected or pasted, with the name of the file it came from.
 */
export interface ImageAttachment {
    name: string;
    image: ImageContent;
}

/**
 * A non-image file attachment.
 */
export interface AttachmentFile {
    name: string;
    size: number;
    mimeType: string;
    localPath?: string;
}

/**
 * Combined list of image and non-image attachments.
 */
export interface AttachmentCandidates {
    images: ImageAttachment[];
    files: AttachmentFile[];
}

/**
 * Opens a native system dialog to select files or folders.
 *
 * Returns an array of paths or URIs selected by the person, or null if cancelled.
 */
export async function selectPaths(options?: SelectOptions): Promise<string[] | null> {
    return call<string[] | null>("select_paths", { options });
}

/**
 * Reads the text contents of a file or Android content URI directly.
 */
export async function readText(path: string): Promise<string> {
    return call<string>("read_text", { path });
}

/**
 * Inspects given file paths or URIs and classifies them as images or file references.
 */
export async function inspectPaths(paths: string[]): Promise<AttachmentCandidates> {
    return call<AttachmentCandidates>("inspect_paths", { paths });
}
