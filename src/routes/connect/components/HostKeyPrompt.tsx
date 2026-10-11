import { cn } from "cn";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";
import { ScrollPane } from "@/components";
import { useIsMobile } from "@/hooks/use-platform";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components";
import type { PresentedKey } from "@/lib/bridge";

export interface HostKeyPromptProps {
    /** The key to ask about. Null is how the machine says there is no question. */
    presentedKey: PresentedKey | null;
    onAnswer: (trusted: boolean) => void;
    /** Pins which host to draw, for previews and tests. */
    isMobile?: boolean;
}

/** Flat, like every other surface here: the hairline carries the edge. */
const FRAME = "border-border bg-card gap-4 border text-foreground";

/** A prompt's title is body type, not a heading. */
const TITLE = "text-body-md font-normal";
const MESSAGE = "text-body-md text-muted-foreground";

/** The longest key a person would paste still has to leave the buttons in reach. */
const MESSAGE_BOX = "max-h-48";

/** The fingerprint as a person checks it against the host. */
function hostKeyMessage(key: PresentedKey): string {
    return `${key.fingerprint} (${key.algorithm}). This host has never been seen.`;
}

/** One outcome each, so one word each. */
function Answers({ id, onAnswer }: { id: string; onAnswer: (trusted: boolean) => void }) {
    return (
        <div className="mt-2 flex justify-end gap-2">
            <Button
                id={`${id}-cancel`}
                onClick={() => onAnswer(false)}
                className="bg-muted hover:bg-muted/80 rounded-lg p-2 px-3"
            >
                <span className="text-label-lg font-medium">Cancel</span>
            </Button>
            <Button
                id={`${id}-trust`}
                onClick={() => onAnswer(true)}
                className="bg-primary hover:bg-primary/90 rounded-lg p-2 px-3"
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
                    // No top padding: the grab bar's own `my-4` is the sheet's top gap.
                    // The bottom gap is the sheet's own and the navigation bar's on top
                    // of it, which is why it is written as one sum.
                    className={cn(FRAME, "px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none")}
                    aria-describedby="host-key-sheet-message"
                >
                    <SheetTitle className={TITLE}>Trust this host?</SheetTitle>
                    {/* The cap belongs to the scroller and not to the words: a
                        percentage height inside an auto-height box never resolves. */}
                    <ScrollPane viewportClassName={MESSAGE_BOX}>
                        <SheetDescription id="host-key-sheet-message" className={MESSAGE}>
                            {message}
                        </SheetDescription>
                    </ScrollPane>
                    <Answers id="host-key-sheet" onAnswer={onAnswer} />
                </SheetContent>
            </Sheet>
        );
    }

    return (
        <Dialog open={open} onOpenChange={refuseOnClose}>
            <DialogContent
                showCloseButton={false}
                className={cn(FRAME, "max-w-104 rounded-xl p-6 ring-0")}
                aria-describedby="host-key-dialog-message"
            >
                <DialogTitle className={TITLE}>Trust this host?</DialogTitle>
                <ScrollPane viewportClassName={MESSAGE_BOX}>
                    <DialogDescription id="host-key-dialog-message" className={MESSAGE}>
                        {message}
                    </DialogDescription>
                </ScrollPane>
                <Answers id="host-key-dialog" onAnswer={onAnswer} />
            </DialogContent>
        </Dialog>
    );
}
