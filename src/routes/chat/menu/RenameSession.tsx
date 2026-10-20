/**
 * The name of the conversation: one field, in a sheet on a phone and a dialog on a
 * desktop.
 *
 * The name is pi's (`set_session_name`). Pi reports the change as a
 * `session_info_changed` record, which makes the state read stale; the host's listing
 * carries the name too and has no such event, so a rename asks it again (`onRenamed`).
 *
 * A name cannot be empty - pi refuses one - so the form does not offer it.
 */

import { useState } from "react";
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
    Input,
    Label,
} from "@/components/ui";
import { useIsMobile } from "@/hooks";
import * as bridge from "@/lib/bridge";

const TITLE = "Rename the conversation";
const DESCRIPTION = "The name the host lists for this conversation.";

export interface RenameSessionProps {
    session: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The name pi holds now, for the field to open with. */
    initial: string | null;
    /** The name was taken: the listing can show it. */
    onRenamed: () => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function RenameSession({ session, open, onOpenChange, initial, onRenamed, isMobile }: RenameSessionProps) {
    // Called whatever `isMobile` says, so pinning it and then stopping is not a
    // change in how many hooks there are.
    const mobile = useIsMobile();
    const [name, setName] = useState(initial ?? "");
    // The shell keeps its body while it is closed; a fresh open begins with the name
    // pi holds now, which a rename may have changed since the last one.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setName(initial ?? "");
    }

    const rename = useMutation({
        mutationFn: (next: string) => bridge.setSessionName(session, next),
        onSuccess: () => {
            onOpenChange(false);
            onRenamed();
        },
        onError: (thrown: unknown) => toast.error(bridge.asPieError(thrown).message),
    });

    const trimmed = name.trim();
    const refused = trimmed === "" || rename.isPending;
    const confirm = () => {
        if (!refused) rename.mutate(trimmed);
    };

    const body = (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                confirm();
            }}
        >
            <Label htmlFor="session-rename-name">Name</Label>
            <Input
                id="session-rename-name"
                value={name}
                autoFocus
                autoComplete="off"
                placeholder="Name this conversation"
                onChange={(event) => setName(event.target.value)}
                className="focus-visible:ring-0"
            />
        </form>
    );

    if (isMobile ?? mobile) {
        return (
            <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="down" showSwipeHandle>
                <DrawerContent
                    className="gap-4 border-border px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none"
                    aria-describedby="session-rename-sheet-description"
                >
                    <DrawerTitle>{TITLE}</DrawerTitle>
                    <DrawerDescription id="session-rename-sheet-description" className="mt-4 text-muted-foreground">
                        {DESCRIPTION}
                    </DrawerDescription>
                    {body}
                    <DrawerFooter className="mt-8 flex flex-row gap-4 p-0">
                        <DrawerClose
                            render={<Button variant="outline" className="h-10 flex-1 text-label-lg font-medium" />}
                        >
                            Cancel
                        </DrawerClose>
                        <Button className="h-10 flex-1 text-label-lg font-medium" disabled={refused} onClick={confirm}>
                            Rename
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
                className="rounded-xl border border-border bg-card p-6 text-foreground"
                aria-describedby="session-rename-dialog-description"
            >
                <DialogTitle className="text-body-md font-normal">{TITLE}</DialogTitle>
                <DialogDescription
                    id="session-rename-dialog-description"
                    className="text-body-md text-muted-foreground"
                >
                    {DESCRIPTION}
                </DialogDescription>
                {body}
                <DialogFooter className="mt-0 flex flex-row justify-end gap-4 border-0 bg-transparent">
                    <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-lg px-4 py-3">
                        <span className="text-label-lg font-medium">Cancel</span>
                    </Button>
                    <Button
                        onClick={confirm}
                        disabled={refused}
                        className="rounded-lg bg-primary px-4 py-3 hover:bg-primary/90"
                    >
                        <span className="text-label-lg font-medium">Rename</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
