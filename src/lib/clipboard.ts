import { isAbsolute } from "pathe";
import { toast } from "sonner";

export interface PastedImage {
    name: string;
    data: string;
    mimeType: string;
}

export interface PastedFile {
    name: string;
    size: number;
    mimeType: string;
    bytesBase64: string;
}

export interface ClipboardPaste {
    images: PastedImage[];
    files: PastedFile[];
    uris: string[];
}

export async function copyText(text: string): Promise<boolean> {
    try {
        const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
        if (!clipboard || typeof clipboard.writeText !== "function") {
            toast.error("This window has no clipboard.");
            return false;
        }
        await clipboard.writeText(text);
        return true;
    } catch {
        toast.error("Nothing was copied.");
        return false;
    }
}

export async function readText(dataTransfer: DataTransfer | null = null): Promise<string | null> {
    if (dataTransfer && typeof dataTransfer.getData === "function") {
        try {
            const text = dataTransfer.getData("text/plain");
            if (text) return text;
        } catch {
            // Fall through to Web Clipboard API.
        }
    }

    try {
        const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
        if (clipboard && typeof clipboard.readText === "function") {
            return await clipboard.readText();
        }
        return null;
    } catch {
        return null;
    }
}

/** Strips the `data:...;base64,` header that `FileReader.readAsDataURL` prepends. */
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

export function extractFiles(dataTransfer: DataTransfer | null): File[] {
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

function isFileUriOrPath(value: string): boolean {
    if (!value) return false;
    if (isAbsolute(value)) return true;
    try {
        const { protocol } = new URL(value);
        return protocol === "file:" || protocol === "content:";
    } catch {
        return false;
    }
}

function parseUris(uriList: string, plainText = ""): string[] {
    const uris: string[] = [];
    if (uriList) {
        for (const line of uriList.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#") && isFileUriOrPath(trimmed)) {
                uris.push(trimmed);
            }
        }
    }
    if (uris.length === 0 && plainText) {
        const lines = plainText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length > 0 && lines.every(isFileUriOrPath)) {
            uris.push(...lines);
        }
    }
    return uris;
}

export function extractUris(dataTransfer: DataTransfer | null): string[] {
    if (!dataTransfer || typeof dataTransfer.getData !== "function") return [];
    return parseUris(dataTransfer.getData("text/uri-list"), dataTransfer.getData("text/plain"));
}

export function hasFilesOrUris(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
    if (dataTransfer.items && dataTransfer.items.length > 0) {
        for (let i = 0; i < dataTransfer.items.length; i++) {
            if (dataTransfer.items[i].kind === "file") return true;
        }
    }
    return extractUris(dataTransfer).length > 0;
}

function isImageFile(mimeType: string, name: string): boolean {
    return mimeType ? mimeType.startsWith("image/") : /\.(png|jpe?g|gif|webp)$/i.test(name);
}

function defaultFileName(mimeType: string): string {
    const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim();
    if (mimeType.startsWith("image/")) {
        return subtype ? `Pasted image.${subtype}` : "Pasted image";
    }
    return subtype ? `pasted-file.${subtype}` : "pasted-file";
}

async function encodeFiles(rawFiles: File[]): Promise<{ images: PastedImage[]; files: PastedFile[] }> {
    const images: PastedImage[] = [];
    const files: PastedFile[] = [];

    for (const file of rawFiles) {
        const isImage = isImageFile(file.type, file.name);
        try {
            const data = await blobToBase64(file);
            if (isImage) {
                images.push({
                    name: file.name || "Pasted image",
                    data,
                    mimeType: file.type || "image/png",
                });
            } else {
                files.push({
                    name: file.name || "pasted-file",
                    size: file.size,
                    mimeType: file.type || "application/octet-stream",
                    bytesBase64: data,
                });
            }
        } catch {
            // Skip unreadable file.
        }
    }

    return { images, files };
}

async function readWebClipboard(): Promise<{ rawFiles: File[]; uris: string[] }> {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) return { rawFiles: [], uris: [] };

    if (typeof clipboard.read === "function") {
        try {
            const items = await clipboard.read();
            const rawFiles: File[] = [];
            let uriList = "";
            let plainText = "";

            for (const item of items) {
                const fileType = item.types.find((type) => !type.startsWith("text/"));
                if (fileType) {
                    const blob = await item.getType(fileType);
                    const mimeType = blob.type || fileType;
                    rawFiles.push(
                        blob instanceof File ? blob : new File([blob], defaultFileName(mimeType), { type: mimeType }),
                    );
                }
                if (item.types.includes("text/uri-list")) {
                    const blob = await item.getType("text/uri-list");
                    uriList += `${await blob.text()}\n`;
                }
                if (item.types.includes("text/plain")) {
                    const blob = await item.getType("text/plain");
                    plainText += `${await blob.text()}\n`;
                }
            }

            const uris = parseUris(uriList, plainText);
            if (rawFiles.length > 0 || uris.length > 0) {
                return { rawFiles, uris };
            }
        } catch {
            // Fall through to readText.
        }
    }

    if (typeof clipboard.readText === "function") {
        try {
            const text = await clipboard.readText();
            const uris = parseUris("", text);
            if (uris.length > 0) {
                return { rawFiles: [], uris };
            }
        } catch {
            // Web clipboard read not permitted or empty.
        }
    }

    return { rawFiles: [], uris: [] };
}

/**
 * Reads pasted images, files, and file URIs:
 * - Reads `DataTransfer` from the DOM `paste` event first when present.
 * - Falls back to the Web Clipboard API (`navigator.clipboard.read` / `readText`).
 */
export async function readClipboard(dataTransfer: DataTransfer | null = null): Promise<ClipboardPaste> {
    let rawFiles = extractFiles(dataTransfer);
    let uris = extractUris(dataTransfer);

    if (rawFiles.length === 0 && uris.length === 0) {
        const fromWeb = await readWebClipboard();
        rawFiles = fromWeb.rawFiles;
        uris = fromWeb.uris;
    }

    const { images, files } = await encodeFiles(rawFiles);
    if (rawFiles.length > 0 && images.length === 0 && files.length === 0 && uris.length === 0) {
        throw new Error("Failed to read pasted files");
    }

    return { images, files, uris };
}
