import { toast } from "sonner";
import * as bridge from "@/lib/bridge";
import type { PickedImage } from "@/lib/bridge";

export interface RawPastedFile {
    name: string;
    size: number;
    mimeType: string;
    localPath?: string;
    bytesBase64?: string;
}

export interface ProcessedPaste {
    images: PickedImage[];
    files: RawPastedFile[];
}

/**
 * Writes text to the system clipboard through Rust commands.
 *
 * WebKitGTK and sandboxed webviews can block web API clipboard access.
 * The Rust backend gives reliable cross-platform clipboard access.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        await bridge.writeClipboardText(text);
        return true;
    } catch {
        toast.error("Nothing was copied.");
        return false;
    }
}

/**
 * Reads text from the system clipboard through Rust commands.
 *
 * WebKitGTK and sandboxed webviews restrict web API readText calls.
 * The Rust backend reads the system clipboard directly without permission prompts.
 */
export async function readText(): Promise<string | null> {
    try {
        return await bridge.readClipboardText();
    } catch {
        return null;
    }
}

/** Converts a Blob into a base64 string without data URI prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result !== "string") {
                reject(new Error("Failed to read blob data"));
                return;
            }
            const comma = result.indexOf(",");
            resolve(comma !== -1 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob data"));
        reader.readAsDataURL(blob);
    });
}

/** Extracts all files from a DataTransfer instance. */
export function extractAllFiles(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];
    const files: File[] = [];
    if (dataTransfer.files && dataTransfer.files.length > 0) {
        for (let i = 0; i < dataTransfer.files.length; i++) {
            files.push(dataTransfer.files[i]);
        }
    }
    if (files.length === 0 && dataTransfer.items && dataTransfer.items.length > 0) {
        for (let i = 0; i < dataTransfer.items.length; i++) {
            const item = dataTransfer.items[i];
            if (item.kind === "file") {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
    }
    return files;
}

/** Extracts file URIs from clipboard data. */
export function extractUris(dataTransfer: DataTransfer | null): string[] {
    if (!dataTransfer) return [];
    const uris: string[] = [];

    const uriList = dataTransfer.getData("text/uri-list");
    if (uriList) {
        for (const line of uriList.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
                uris.push(trimmed);
            }
        }
    }

    if (uris.length === 0) {
        const plain = dataTransfer.getData("text/plain");
        if (plain) {
            for (const line of plain.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.startsWith("file://") || trimmed.startsWith("/")) {
                    uris.push(trimmed);
                }
            }
        }
    }

    return uris;
}

/** Checks synchronously whether paste data contains file items or URI lists. */
export function hasPastedFilesOrUris(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
    if (dataTransfer.items && dataTransfer.items.length > 0) {
        for (let i = 0; i < dataTransfer.items.length; i++) {
            if (dataTransfer.items[i].kind === "file") return true;
        }
    }
    const uriList = dataTransfer.getData("text/uri-list");
    return Boolean(uriList && uriList.trim() !== "");
}

/**
 * Processes a clipboard paste event across webviews and OS file managers.
 *
 * 1. Checks DOM files or blobs in DataTransfer (in-memory drops or web paste).
 * 2. Checks URI lists and paths via Rust `importPaths` (file manager copies).
 * 3. Falls back to native OS clipboard via Rust `readClipboard` (resolving WebKitGTK bug #218519).
 */
export async function processPaste(dataTransfer: DataTransfer | null): Promise<ProcessedPaste> {
    const allFiles = extractAllFiles(dataTransfer);
    if (allFiles.length > 0) {
        const images: PickedImage[] = [];
        const files: RawPastedFile[] = [];
        for (const file of allFiles) {
            const isImage = file.type ? file.type.startsWith("image/") : /\.(png|jpe?g|gif|webp)$/i.test(file.name);
            if (isImage) {
                try {
                    const data = await blobToBase64(file);
                    images.push({
                        name: file.name || "Pasted image",
                        image: {
                            type: "image",
                            data,
                            mimeType: file.type || "image/png",
                        },
                    });
                } catch {
                    // Skip unreadable image
                }
            } else {
                try {
                    const base64 = await blobToBase64(file);
                    files.push({
                        name: file.name || "pasted-file",
                        size: file.size,
                        mimeType: file.type || "application/octet-stream",
                        bytesBase64: base64,
                    });
                } catch {
                    // Skip unreadable file
                }
            }
        }
        if (images.length > 0 || files.length > 0) {
            return { images, files };
        }
    }

    const uris = extractUris(dataTransfer);
    if (uris.length > 0) {
        try {
            const result = await bridge.importPaths(uris);
            const rawFiles: RawPastedFile[] = result.files.map((f) => ({
                name: f.name,
                size: f.size,
                mimeType: f.mimeType,
                localPath: f.localPath,
            }));
            if (result.images.length > 0 || rawFiles.length > 0) {
                return { images: result.images, files: rawFiles };
            }
        } catch {
            // Fall through to native clipboard
        }
    }

    try {
        const native = await bridge.readClipboard();
        if (native && (native.images.length > 0 || native.files.length > 0)) {
            const rawFiles: RawPastedFile[] = native.files.map((f) => ({
                name: f.name,
                size: f.size,
                mimeType: f.mimeType,
                localPath: f.localPath,
            }));
            return { images: native.images, files: rawFiles };
        }
    } catch {
        // Native clipboard unavailable
    }

    return { images: [], files: [] };
}
