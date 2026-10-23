/**
 * Staging an attachment where pi can read it: on this device, or on the host.
 *
 * The mirror of `src-tauri/src/commands/attachment.rs`.
 */

import { listen } from "@tauri-apps/api/event";
import { call, type Unsubscribe } from "./invoke";

/**
 * The result of staging a file attachment.
 */
export interface StagedAttachment {
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
 * Stages a file attachment on the active host (local path or remote SFTP upload).
 */
export async function stageAttachment(
    uploadId: string,
    name: string,
    localPath?: string,
    bytesBase64?: string,
): Promise<StagedAttachment> {
    return call<StagedAttachment>("stage_attachment", {
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
