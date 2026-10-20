import { ConfirmDialog } from "@/components";
import { useIsMobile } from "@/hooks";
import type { PresentedKey } from "@/lib/bridge";

export interface HostKeyPromptProps {
    /** The key to ask about. Null is how the machine says there is no question. */
    presentedKey: PresentedKey | null;
    onAnswer: (trusted: boolean) => void;
    /** Pins which host to draw, for previews and tests. */
    isMobile?: boolean;
}

/**
 * The fingerprint as a person checks it against the host, and what the answer
 * decides. A first connection carries no other evidence, so the card asks for
 * the check instead of assuming the answer.
 */
function hostKeyMessage(key: PresentedKey): string {
    return `${key.fingerprint} (${key.algorithm}). This host has never been seen. Check the fingerprint on the host before you trust it.`;
}

export function HostKeyPrompt({ presentedKey, onAnswer, isMobile }: HostKeyPromptProps) {
    // Called whatever `isMobile` says, so pinning it and then stopping is not a
    // change in how many hooks there are.
    const mobile = useIsMobile();
    const open = presentedKey !== null;
    const message = presentedKey === null ? "" : hostKeyMessage(presentedKey);

    // A dismissal is a refusal: Rust would otherwise keep waiting on a question
    // nobody is left to answer.
    const refuseOnClose = (next: boolean) => {
        if (!next && open) onAnswer(false);
    };

    return (
        <ConfirmDialog
            open={open}
            onOpenChange={refuseOnClose}
            isMobile={isMobile ?? mobile}
            id="host-key"
            title="Trust this host?"
            description={message}
            descriptionClassName="break-all"
            confirmLabel="Trust"
            confirmId="host-key-trust"
            cancelId="host-key-cancel"
            onConfirm={() => onAnswer(true)}
        />
    );
}
