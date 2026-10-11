import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button, Kbd, KbdGroup } from "@/components/ui";

/**
 * What the window shows while no conversation is open.
 *
 * The window has no editor, so it has no document: the middle holds the words of
 * pi and the keys of the window, the way an editor's own empty window does. The
 * keys are the window's own plan and their bindings are not made yet (see
 * `docs/TODO.md`): a press on them does nothing until the global keys land, so a
 * reader is told what the window will do, not what it does now.
 */
export function ChatLanding({ disconnected }: { disconnected: boolean }) {
    return (
        <div id="chat-landing" className="m-auto flex flex-col items-center gap-10 p-6">
            <p className="text-body-lg text-muted-foreground text-center">
                There are many agent harnesses,
                <br />
                but this one is yours.
            </p>
            <dl className="grid grid-cols-[1fr_auto] items-center gap-x-8 gap-y-2">
                <Shortcut label="Sessions">
                    <Kbd>Ctrl</Kbd>+<Kbd>B</Kbd>
                </Shortcut>
                <Shortcut label="New session">
                    <Kbd>Ctrl</Kbd>+<Kbd>N</Kbd>
                </Shortcut>
            </dl>
            {disconnected && (
                <div className="flex flex-col items-center gap-2">
                    <p className="text-body-sm text-muted-foreground">This window is not connected to a host.</p>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/">Connect</Link>
                    </Button>
                </div>
            )}
        </div>
    );
}

/** One row of the keys: what the window does on the left, the keys on the right. */
function Shortcut({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-body-md text-muted-foreground">{label}</dt>
            <dd>
                <KbdGroup className="text-muted-foreground">{children}</KbdGroup>
            </dd>
        </>
    );
}
