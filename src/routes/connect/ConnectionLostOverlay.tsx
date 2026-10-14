/**
 * The one surface of a lost connection: the app, blurred, under a card that offers to dial
 * the machine again.
 *
 * Every other way of saying it is gone on purpose. A read that fails says so where it was
 * read, and a transcript that stops says nothing at all - neither can tell a quiet model
 * from a host that went away. This is the only place that says it, and it says it over
 * whatever page is up, because the connection is not a page's business.
 *
 * It is built on Base UI's dialog, which is what brings a real `alertdialog`: the keyboard
 * stays inside the card, the page behind it is inert, and a screen reader hears the card
 * rather than the conversation it covers. The overlay is this component's own, because the
 * blur is the point: the app must read as still there, not as replaced.
 *
 * `Escape` leaves for the gate and never dismisses the card silently. A dead connection
 * that nobody named is what this whole surface exists to prevent.
 */

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { ON_SCREEN, type ConnectionWatchState } from "@/machines/connection-watch.machine";

export interface ConnectionLostOverlayProps {
    /** Where the reach stands. Only the states of {@link ON_SCREEN} are on screen. */
    state: ConnectionWatchState;
    /** The machine pie reached: `user@host:port`, or `local`. */
    endpoint: string;
    /** What a dial that failed said, or `null`. */
    message: string | null;
    onRetry: () => void;
    onLeave: () => void;
}

export function ConnectionLostOverlay({ state, endpoint, message, onRetry, onLeave }: ConnectionLostOverlayProps) {
    const open = ON_SCREEN.includes(state);
    const trying = state === "retrying";

    return (
        <DialogPrimitive.Root
            open={open}
            onOpenChange={(_next, details) => {
                // The keyboard's way out is the gate, and it says so by taking it.
                if (details.reason === "escape-key") {
                    onLeave();
                    return;
                }
                // A stray press outside is a stray press, not an answer.
                if (details.reason === "outside-press" || details.reason === "focus-out") {
                    details.cancel();
                }
            }}
        >
            <DialogPrimitive.Portal>
                {/* The plane stays visible through it: a blurred window, not a new one. */}
                <DialogPrimitive.Backdrop className="bg-surface/60 fixed inset-0 z-50 backdrop-blur-md" />
                <DialogPrimitive.Popup
                    // Base UI's dialog is announced as a dialog; this one interrupts, so it says
                    // so. The keyboard stays inside it either way.
                    role="alertdialog"
                    aria-describedby="connection-lost-message"
                    className="bg-card text-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl p-6 shadow-md ring-1 duration-150 outline-none sm:max-w-104"
                >
                    <DialogPrimitive.Title className="text-title-lg font-medium">
                        {`The connection to ${endpoint} was lost`}
                    </DialogPrimitive.Title>

                    <DialogPrimitive.Description
                        id="connection-lost-message"
                        className="text-body-sm text-muted-foreground"
                    >
                        {trying
                            ? "Trying again…"
                            : message === null
                              ? `Pie kept the way it reached ${endpoint}, and can try it again.`
                              : message}
                    </DialogPrimitive.Description>

                    <div className="mt-2 flex justify-end gap-2">
                        <Button variant="outline" onClick={onLeave} className="rounded-lg p-2 px-3">
                            <span className="text-label-lg font-medium">Go to the gate</span>
                        </Button>
                        <Button
                            onClick={onRetry}
                            disabled={trying}
                            autoFocus
                            className="bg-primary hover:bg-primary/90 rounded-lg p-2 px-3"
                        >
                            {trying && <Loader2 className="size-4 animate-spin" />}
                            <span className="text-label-lg font-medium">{trying ? "Reconnecting" : "Reconnect"}</span>
                        </Button>
                    </div>
                </DialogPrimitive.Popup>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
