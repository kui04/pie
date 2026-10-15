import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerTitle,
} from "@/components/ui";
import { useIsMobile } from "@/hooks/usePlatform";
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

    if (isMobile ?? mobile) {
        return (
            <Drawer open={open} onOpenChange={refuseOnClose} swipeDirection="down" showSwipeHandle>
                <DrawerContent
                    // Full registry look for review: no face overrides here. The
                    // border color stays pie's own: without it the hairline paints
                    // in currentColor, which reads as a light rim in dark mode.
                    className="border-border gap-4 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none"
                    aria-describedby="host-key-sheet-message"
                >
                    <DrawerTitle>Trust this host?</DrawerTitle>
                    <DrawerDescription id="host-key-sheet-message" className="text-muted-foreground mt-4 break-all">
                        {message}
                    </DrawerDescription>
                    <DrawerFooter className="mt-8 flex flex-row gap-4 p-0">
                        <DrawerClose
                            render={
                                <Button
                                    id="host-key-sheet-cancel"
                                    variant="outline"
                                    className="text-label-lg h-10 flex-1 font-medium"
                                />
                            }
                        >
                            Cancel
                        </DrawerClose>
                        <Button
                            id="host-key-sheet-trust"
                            className="text-label-lg h-10 flex-1 font-medium"
                            onClick={() => onAnswer(true)}
                        >
                            Trust
                        </Button>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={refuseOnClose}>
            <DialogContent
                showCloseButton={false}
                className="border-border bg-card text-foreground rounded-xl border p-6"
                aria-describedby="host-key-dialog-message"
            >
                <DialogTitle className="text-body-md font-normal">Trust this host?</DialogTitle>
                <DialogDescription
                    id="host-key-dialog-message"
                    className="text-body-md text-muted-foreground break-all"
                >
                    {message}
                </DialogDescription>
                <DialogFooter className="mt-0 flex flex-row justify-end gap-4 border-0 bg-transparent">
                    <Button
                        id="host-key-dialog-cancel"
                        variant="outline"
                        onClick={() => onAnswer(false)}
                        className="rounded-lg px-4 py-3"
                    >
                        <span className="text-label-lg font-medium">Cancel</span>
                    </Button>
                    <Button
                        id="host-key-dialog-trust"
                        onClick={() => onAnswer(true)}
                        className="bg-primary hover:bg-primary/90 rounded-lg px-4 py-3"
                    >
                        <span className="text-label-lg font-medium">Trust</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
