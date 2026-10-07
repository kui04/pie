import { toast } from "sonner";

/**
 * Puts text on the clipboard, and says so when the webview refuses.
 *
 * A webview without a clipboard does not reject: it throws on the spot, on the
 * property or on the call. One `try` covers both, so this always answers.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        const clipboard = navigator.clipboard;
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
