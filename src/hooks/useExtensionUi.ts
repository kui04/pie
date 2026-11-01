/**
 * The extension dialogs and status lines of one conversation.
 *
 * The state lives in `lib/extension/store.ts`, which hears the channels once for the whole
 * window. This hook is the read that a screen does on it, and the answer it sends back.
 */

import type { ExtensionAnswer } from "@/lib/bridge";
import type { SessionKey } from "@/lib/session";
import {
    answerDialog,
    useDialogs,
    useEditorText,
    useStatuses,
    type PendingDialog,
    type StatusLine,
} from "@/lib/extension/store";

export function useExtensionUi(key: SessionKey): {
    /** The dialog at the head of the queue, if one waits. */
    request: PendingDialog | null;
    /** The status lines the extensions reported. */
    statuses: StatusLine[];
    /** The text an extension put in the editor, or `null`. */
    editorText: string | null;
    answer: (id: number, answer: ExtensionAnswer) => void;
} {
    const dialogs = useDialogs(key);
    const statuses = useStatuses(key);
    const editorText = useEditorText(key);

    return {
        request: dialogs[0] ?? null,
        statuses,
        editorText,
        answer: (id, answer) => void answerDialog(id, answer),
    };
}
