/**
 * Native OS clipboard operations.
 *
 * The mirror of `src-tauri/src/commands/clipboard.rs`.
 *
 * WebKitGTK and sandboxed webviews restrict clipboard access:
 * - WebKitGTK drops screenshot images from DataTransfer (WebKit Bug #218519).
 * - Sandboxed webviews block file:// paths and prompt for clipboard read permissions.
 *
 * All clipboard operations default to Rust commands for cross-platform reliability.
 */

import { call } from "./invoke";
import type { PickedAttachments } from "./files";

/**
 * Reads image data or file references directly from the native OS clipboard.
 */
export async function readClipboard(): Promise<PickedAttachments | null> {
    return call<PickedAttachments | null>("read_clipboard");
}

/**
 * Reads plain text from the native OS clipboard.
 */
export async function readClipboardText(): Promise<string | null> {
    return call<string | null>("read_clipboard_text");
}

/**
 * Writes plain text to the native OS clipboard.
 */
export async function writeClipboardText(text: string): Promise<void> {
    return call<void>("write_clipboard_text", { text });
}
