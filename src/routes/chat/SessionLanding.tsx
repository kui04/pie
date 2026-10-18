/**
 * The page that stands while no conversation is open: the words of pi, and what the
 * window can do from here.
 *
 * Both rows are the actions themselves, not only their keys: the keys belong to the
 * window's own handling (`chat.machine`), and a press is what a touch screen has.
 */

import type { ReactNode } from "react";
import { Kbd, KbdGroup } from "@/components/ui";

export interface SessionLandingProps {
    /** Show or hide the session list: the window's own action, under `Ctrl+B`. */
    onSessions?: () => void;
    /** Choose a directory for a new conversation, under `Ctrl+N`. */
    onNew?: () => void;
}

export function SessionLanding({ onSessions, onNew }: SessionLandingProps) {
    return (
        <div id="chat-landing" className="m-auto flex flex-col items-center gap-10 p-6">
            <p className="text-body-lg text-muted-foreground text-center">
                There are many agent harnesses,
                <br />
                but this one is yours.
            </p>
            <div className="grid w-full max-w-xs gap-1">
                <Shortcut id="landing-sessions" label="Sessions" onPress={onSessions}>
                    <Kbd>Ctrl</Kbd>+<Kbd>B</Kbd>
                </Shortcut>
                <Shortcut id="landing-new" label="New session" onPress={onNew}>
                    <Kbd>Ctrl</Kbd>+<Kbd>N</Kbd>
                </Shortcut>
            </div>
        </div>
    );
}

/** One row of the window's actions: what it does on the left, its keys on the right. */
function Shortcut({
    id,
    label,
    onPress,
    children,
}: {
    id: string;
    label: string;
    onPress?: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            id={id}
            onClick={onPress}
            className="hover:bg-accent flex items-center justify-between gap-8 rounded-md px-3 py-2"
        >
            <span className="text-body-md text-muted-foreground">{label}</span>
            <KbdGroup className="text-muted-foreground">{children}</KbdGroup>
        </button>
    );
}
