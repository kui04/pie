import type { ReactNode } from "react";
import { Kbd, KbdGroup } from "@/components/ui";

/** The page that stands while no conversation is open: the words of pi, and the keys. */
export function SessionLanding() {
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
