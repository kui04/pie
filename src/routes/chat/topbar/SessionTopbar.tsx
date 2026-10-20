import { AnimatePresence, motion } from "motion/react";
import { useMotion } from "@/hooks";

/**
 * The conversation's own slot of the bar: what it is called.
 *
 * The rest of the bar belongs to the window - the way to the list, its actions and the
 * window's keys - so it stands still; this slot belongs to the conversation in view, and it
 * is the only part of the bar that changes when another conversation opens. A session that
 * is still on its way has nothing to say about itself, so its slot arrives with its words.
 */
export function SessionTopbar({
    name,
    firstMessage,
    cwd,
    ready = true,
}: {
    name: string | null;
    /** The words that opened the session, when pi has no name for it. */
    firstMessage?: string | null;
    /** The directory the session runs in, for a session with neither words nor a name. */
    cwd: string | null;
    /** Whether the conversation has arrived; its slot waits for it until it has. */
    ready?: boolean;
}) {
    const { slot } = useMotion();
    const shown = title(name, firstMessage ?? null, cwd);

    return (
        <AnimatePresence initial={false}>
            {ready && (
                <motion.div
                    {...slot}
                    // The words are the identity: another session brings other ones, and the
                    // block that says them fades rather than swapping its text in place.
                    key={name ?? firstMessage ?? cwd ?? "session"}
                    className="flex min-w-0 flex-1 items-center"
                >
                    {/* No preview card on this one: it is a position, not a reading. */}
                    <h1
                        id="session_name"
                        className="
                            me-12 max-w-160 min-w-0 flex-1 truncate ps-2 text-left text-title-sm
                            xl:absolute xl:top-1/2 xl:left-1/2 xl:m-0 xl:w-max xl:-translate-x-1/2 xl:-translate-y-1/2
                            xl:p-0 xl:text-center
                        "
                    >
                        {shown}
                    </h1>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

/**
 * The name pi holds, else the words that opened the conversation, else the last
 * part of its directory: the same title the session row says.
 */
function title(name: string | null, firstMessage: string | null, cwd: string | null): string {
    const given = name?.trim();
    if (given) return given;
    const opened = firstMessage?.trim().replace(/\s+/g, " ");
    if (opened) return opened;
    const parts = cwd?.split(/[\\/]/).filter(Boolean) ?? [];
    return parts[parts.length - 1] ?? "Untitled";
}
