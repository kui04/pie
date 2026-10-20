/**
 * Fork a conversation at one of its user messages: a sheet on a phone, a dialog on a
 * desktop, and the fork points pi reports (`get_fork_messages`) inside it.
 *
 * Pi lists every user message with text, on the current branch and on the others of a
 * fork, which is what its own selector shows; the entry id of the chosen row is the
 * fork point. The fork happens in this process, so the conversation changes and the
 * session does not: the caller reads the state and the entries again and lets the rows
 * of the old conversation go (`onForked`).
 *
 * The list is read when the shell opens, and only then: a long conversation has many
 * rows, and nothing changes them while it stands.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
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
    Skeleton,
} from "@/components/ui";
import { ScrollPane, TruncatedText } from "@/components";
import { useIsMobile } from "@/hooks/usePlatform";
import * as bridge from "@/lib/bridge";
import { sessionQueries } from "@/lib/query";

const TITLE = "Fork from a message";
const DESCRIPTION = "The conversation begins again before the message you pick.";

export interface ForkSessionProps {
    session: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The process holds a new branch: the caller reads the state and the entries again. */
    onForked: () => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function ForkSession({ session, open, onOpenChange, onForked, isMobile }: ForkSessionProps) {
    // Called whatever `isMobile` says, so pinning it and then stopping is not a
    // change in how many hooks there are.
    const mobile = useIsMobile();
    const points = useQuery({ ...sessionQueries.forkMessages(session), enabled: open });
    const fork = useMutation({
        mutationFn: (entryId: string) => bridge.forkSession(session, entryId),
        onSuccess: (result) => {
            onOpenChange(false);
            if (result.cancelled) {
                toast("An extension refused the fork.");
                return;
            }
            onForked();
        },
        onError: (thrown: unknown) => toast.error(bridge.asPieError(thrown).message),
    });

    const body = (
        <ScrollPane id="session-fork-scroll" className="min-h-0 flex-1" viewportClassName="-mx-2">
            {points.isError ? (
                <p id="session-fork-failure" role="alert" className="p-2 text-body-md text-muted-foreground">
                    {bridge.asPieError(points.error).message}
                </p>
            ) : points.isPending ? (
                <div role="status" aria-label="Reading the messages" className="space-y-1 px-2">
                    {[0, 1, 2, 3].map((row) => (
                        <Skeleton key={row} className="h-10 w-full motion-reduce:animate-none" />
                    ))}
                </div>
            ) : points.data.length === 0 ? (
                <p className="p-2 text-body-md text-muted-foreground">No messages to fork from</p>
            ) : (
                <div className="space-y-0.5 px-2">
                    {points.data.map((point) => (
                        <button
                            key={point.entryId}
                            type="button"
                            id={`session-fork-point-${point.entryId}`}
                            disabled={fork.isPending}
                            onClick={() => fork.mutate(point.entryId)}
                            className="
                                flex w-full rounded-md p-2 text-left outline-none
                                hover:bg-accent/50
                                focus-visible:bg-accent
                                disabled:pointer-events-none disabled:opacity-50
                            "
                        >
                            <TruncatedText
                                content={point.text}
                                contentClassName="max-h-[min(60dvh,var(--available-height))] overflow-y-auto whitespace-pre-wrap"
                                lines={2}
                                offset={{ top: 8, right: 12, bottom: 8, left: 12 }}
                                className="text-body-md wrap-break-word"
                            >
                                {point.text}
                            </TruncatedText>
                        </button>
                    ))}
                </div>
            )}
        </ScrollPane>
    );

    if (isMobile ?? mobile) {
        return (
            <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="down" showSwipeHandle>
                <DrawerContent
                    className="
                        flex h-[70dvh] flex-col gap-4 border-border px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]
                        outline-none
                    "
                    aria-describedby="session-fork-sheet-description"
                >
                    <DrawerTitle>{TITLE}</DrawerTitle>
                    <DrawerDescription id="session-fork-sheet-description" className="mt-4 text-muted-foreground">
                        {DESCRIPTION}
                    </DrawerDescription>
                    {body}
                    <DrawerFooter className="mt-8 flex flex-row gap-4 p-0">
                        <DrawerClose
                            render={<Button variant="outline" className="h-10 flex-1 text-label-lg font-medium" />}
                        >
                            Cancel
                        </DrawerClose>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                // A height, not a maximum: the viewport of a `ScrollPane` fills its root by
                // percentage, and a percentage resolves only against a definite height. Under
                // `max-h` the list would paint past the frame instead of scrolling.
                className="flex h-[70dvh] flex-col rounded-xl border border-border bg-card p-6 text-foreground"
                aria-describedby="session-fork-dialog-description"
            >
                <DialogTitle className="text-body-md font-normal">{TITLE}</DialogTitle>
                <DialogDescription id="session-fork-dialog-description" className="text-body-md text-muted-foreground">
                    {DESCRIPTION}
                </DialogDescription>
                {body}
                <DialogFooter className="mt-0 flex flex-row justify-end gap-4 border-0 bg-transparent">
                    <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-lg px-4 py-3">
                        <span className="text-label-lg font-medium">Cancel</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
