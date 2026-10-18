/**
 * Delete the conversation of this session: a sheet on a phone, a dialog on a desktop,
 * and one confirmation inside it.
 *
 * Pi has no command for this, so the flow is pie's own: end the process that holds the
 * conversation first - a pi that kept writing to a removed file writes into a name
 * nobody can open again - and then remove the file on the machine that holds it. A fork
 * is not damaged: a branch holds a copy of the entries it keeps, and the path in its
 * header only names the tree of pi's selector.
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

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
import * as bridge from "@/lib/bridge";

const TITLE = "Delete this conversation?";
const DESCRIPTION = "The messages leave this machine. A conversation forked from this one keeps its own copy.";

export interface DeleteSessionProps {
    session: string;
    /** The file of the conversation, from its state; `null` while the state is not read. */
    file: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The process ended and the file is gone: the caller reads and leaves the session. */
    onDeleted: () => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function DeleteSession({ session, file, open, onOpenChange, onDeleted, isMobile }: DeleteSessionProps) {
    // Called whatever `isMobile` says, so pinning it and then stopping is not a
    // change in how many hooks there are.
    const mobile = useIsMobile();
    const remove = useMutation({
        mutationFn: async (path: string) => {
            if (session !== "") {
                await bridge.detachSession(session);
            }
            await bridge.deleteSession(path);
        },
        onSuccess: () => {
            onOpenChange(false);
            onDeleted();
        },
        onError: (thrown: unknown) => toast.error(bridge.asPieError(thrown).message),
    });

    const refused = file === null || remove.isPending;
    const confirm = () => {
        if (file !== null && !remove.isPending) remove.mutate(file);
    };

    if (isMobile ?? mobile) {
        return (
            <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="down" showSwipeHandle>
                <DrawerContent
                    className="border-border gap-4 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none"
                    aria-describedby="session-delete-sheet-description"
                >
                    <DrawerTitle>{TITLE}</DrawerTitle>
                    <DrawerDescription id="session-delete-sheet-description" className="text-muted-foreground mt-4">
                        {DESCRIPTION}
                    </DrawerDescription>
                    <DrawerFooter className="mt-8 flex flex-row gap-4 p-0">
                        <DrawerClose
                            render={<Button variant="outline" className="text-label-lg h-10 flex-1 font-medium" />}
                        >
                            Cancel
                        </DrawerClose>
                        <Button
                            variant="destructive"
                            className="text-label-lg h-10 flex-1 font-medium"
                            disabled={refused}
                            onClick={confirm}
                        >
                            Delete
                        </Button>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="border-border bg-card text-foreground rounded-xl border p-6"
                aria-describedby="session-delete-dialog-description"
            >
                <DialogTitle className="text-body-md font-normal">{TITLE}</DialogTitle>
                <DialogDescription
                    id="session-delete-dialog-description"
                    className="text-body-md text-muted-foreground"
                >
                    {DESCRIPTION}
                </DialogDescription>
                <DialogFooter className="mt-0 flex flex-row justify-end gap-4 border-0 bg-transparent">
                    <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-lg px-4 py-3">
                        <span className="text-label-lg font-medium">Cancel</span>
                    </Button>
                    <Button variant="destructive" onClick={confirm} disabled={refused} className="rounded-lg px-4 py-3">
                        <span className="text-label-lg font-medium">Delete</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
