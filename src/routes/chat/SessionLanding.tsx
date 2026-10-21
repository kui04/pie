/**
 * The page that stands while no conversation is open: the words of pi, and the keys
 * the window offers from here.
 *
 * The rows name those keys; they are labels, not controls. The window itself owns
 * the shortcuts.
 */

import type { ReactNode } from "react";
import { Kbd, KbdGroup } from "@/components/ui";

export function SessionLanding() {
    return (
        <div id="chat-landing" className="m-auto flex flex-col items-center gap-10 p-6">
            <p className="text-center text-body-lg text-muted-foreground">
                There are many agent harnesses,
                <br />
                but this one is yours.
            </p>
            <div className="grid w-full max-w-xs gap-1">
                <Shortcut id="landing-sessions" label="Sessions">
                    <Kbd>Ctrl</Kbd>+<Kbd>B</Kbd>
                </Shortcut>
                <Shortcut id="landing-new" label="New session">
                    <Kbd>Ctrl</Kbd>+<Kbd>N</Kbd>
                </Shortcut>
            </div>
        </div>
    );
}

/** One row of the window's keys: what it does on the left, its keys on the right. */
function Shortcut({ id, label, children }: { id: string; label: string; children: ReactNode }) {
    return (
        <div id={id} className="flex items-center justify-between gap-8 rounded-md px-3 py-2">
            <span className="text-body-md text-muted-foreground">{label}</span>
            <KbdGroup className="text-muted-foreground">{children}</KbdGroup>
        </div>
    );
}
