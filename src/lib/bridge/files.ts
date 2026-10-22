/**
 * File dialog picking, path importing, attachment staging, and temporary file management.
 *
 * The mirror of `src-tauri/src/commands/files.rs`.
 */

import { listen } from "@tauri-apps/api/event";
import type { ImageContent } from "@/lib/rpc-protocol";
import { call, type Unsubscribe } from "./invoke";

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
 * Target type for the system picker dialog.
 */
export type PickTarget = "file" | "folder";

/**
 * Configuration options for opening a native file or folder picker dialog.
 */
export interface PickOptions {
    /** Window title of the dialog. */
    title?: string;
    /** Whether multiple items can be chosen. */
    multiple?: boolean;
    /** Target item type: file or folder. */
    target?: PickTarget;
    /** File extension filters. */
    filters?: DialogFilter[];
}

/**
 * One image that a person picked or pasted, with the name of the file it came from.
 */
export interface PickedImage {
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
export interface PickedAttachments {
    images: PickedImage[];
    files: AttachmentFile[];
}

/**
 * The result of staging a file attachment.
 */
export interface PreparedAttachment {
    path: string;
    size: number;
    mimeType: string;
}

/**
 * Progress event emitted while uploading a file to a remote host.
 */
export type UploadEvent = {
    type: "progress";
    transferred: number;
    total: number;
};

/**
 * Opens a native system dialog to pick files or folders.
 *
 * Returns an array of paths or URIs selected by the person, or null if cancelled.
 */
export async function pickPaths(options?: PickOptions): Promise<string[] | null> {
    return call<string[] | null>("pick_paths", { options });
}

/**
 * Reads the text contents of a file or Android content URI directly.
 */
export async function readTextFile(path: string): Promise<string> {
    return call<string>("read_text_file", { path });
}

/**
 * Imports given file paths or URIs into image attachments or file references.
 */
export async function importPaths(paths: string[]): Promise<PickedAttachments> {
    return call<PickedAttachments>("import_paths", { paths });
}

/**
 * Prepares a file attachment for the active host (local path or remote SFTP upload).
 */
export async function prepareAttachment(
    uploadId: string,
    name: string,
    localPath?: string,
    bytesBase64?: string,
): Promise<PreparedAttachment> {
    return call<PreparedAttachment>("prepare_attachment", {
        uploadId,
        name,
        localPath,
        bytesBase64,
    });
}

/**
 * Listens to upload progress events on `pi://upload/{uploadId}`.
 */
export function onUploadProgress(uploadId: string, onProgress: (event: UploadEvent) => void): Promise<Unsubscribe> {
    return listen<UploadEvent>(`pi://upload/${uploadId}`, (event) => onProgress(event.payload));
}
