import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";
import { ScrollPane } from "@/components";
import { useIsMobile } from "@/hooks/use-platform";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components";
import type { PresentedKey } from "@/lib/bridge";
import { cn } from "cn";

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

/**
 * One outcome each, so one word each. A thumb gets the height the design asks of
 * a control on a touch pointer; a pointer keeps the dense one. The second answer
 * is the outline the design gives a second action.
 */
function Answers({
    id,
    onAnswer,
    touch = false,
}: {
    id: string;
    onAnswer: (trusted: boolean) => void;
    /** Whether this row is answered by a thumb. */
    touch?: boolean;
}) {
    const size = touch ? "h-12 px-4" : "p-2 px-3";

    return (
        <div className="mt-2 flex justify-end gap-2">
            <Button
                id={`${id}-cancel`}
                variant="outline"
                onClick={() => onAnswer(false)}
                className={cn("rounded-lg", size)}
            >
                <span className="text-label-lg font-medium">Cancel</span>
            </Button>
            <Button
                id={`${id}-trust`}
                onClick={() => onAnswer(true)}
                className={cn("bg-primary hover:bg-primary/90 rounded-lg", size)}
            >
                <span className="text-label-lg font-medium">Trust</span>
            </Button>
        </div>
    );
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

    if (isMobile ?? mobile) {
        return (
            <Sheet open={open} onOpenChange={refuseOnClose} direction="bottom">
                <SheetContent
                    overlayClassName="bg-surface-container-highest/70 fixed inset-0 z-40"
                    className={cn(
                        "border-border bg-card text-foreground gap-4 border",
                        "px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none",
                    )}
                    aria-describedby="host-key-sheet-message"
                >
                    <SheetTitle className="text-body-md font-normal">Trust this host?</SheetTitle>
                    {/* The cap belongs to the scroller and not to the words: a
                        percentage height inside an auto-height box never resolves. */}
                    <ScrollPane viewportClassName="max-h-48">
                        <SheetDescription id="host-key-sheet-message" className="text-body-md text-muted-foreground">
                            {message}
                        </SheetDescription>
                    </ScrollPane>
                    <Answers id="host-key-sheet" onAnswer={onAnswer} touch />
                </SheetContent>
            </Sheet>
        );
    }

    return (
        <Dialog open={open} onOpenChange={refuseOnClose}>
            <DialogContent
                showCloseButton={false}
                className="border-border bg-card text-foreground max-w-104 gap-4 rounded-xl border p-6"
                aria-describedby="host-key-dialog-message"
            >
                <DialogTitle className="text-body-md font-normal">Trust this host?</DialogTitle>
                <ScrollPane viewportClassName="max-h-48">
                    <DialogDescription id="host-key-dialog-message" className="text-body-md text-muted-foreground">
                        {message}
                    </DialogDescription>
                </ScrollPane>
                <Answers id="host-key-dialog" onAnswer={onAnswer} />
            </DialogContent>
        </Dialog>
    );
}
