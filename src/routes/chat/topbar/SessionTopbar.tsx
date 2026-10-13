import { AnimatePresence, motion } from "motion/react";
import { useMotion } from "@/hooks/use-motion";
import { UsagePopover } from "@/routes/chat/topbar/UsagePopover";
import type { SessionStats } from "@/lib/rpc-protocol";

/**
 * The session's own slots of the bar: what it is called, and how full its context is.
 *
 * The rest of the bar belongs to the window - the way to the list, and the window's own
 * keys - so it stands still; these two belong to the conversation in view, and they are the
 * only part of the bar that changes when another conversation opens. A session that is
 * still on its way has nothing to say about itself, so its slots arrive with its words.
 */
export function SessionTopbar({
    name,
    cwd,
    stats,
    auto,
    ready = true,
}: {
    name: string | null;
    /** The directory the session runs in, for a session pi has no name for. */
    cwd: string | null;
    stats: SessionStats | null;
    auto: boolean;
    /** Whether the conversation has arrived; its slots wait for it until it has. */
    ready?: boolean;
}) {
    const { slot } = useMotion();

    return (
        <AnimatePresence initial={false}>
            {ready && (
                <motion.div
                    {...slot}
                    // The words are the identity: another session brings other ones, and the
                    // block that says them fades rather than swapping its text in place.
                    key={name ?? cwd ?? "session"}
                    className="flex min-w-0 flex-1 items-center gap-1"
                >
                    <h1 id="session_name" className="text-title-sm min-w-0 flex-1 truncate px-2 text-center">
                        {title(name, cwd)}
                    </h1>
                    <span id="session_controllers" className="flex shrink-0 items-center gap-1">
                        <UsagePopover id="session-usage" stats={stats} auto={auto} />
                    </span>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

/** The name pi holds, else the last part of the directory, as pi's own title falls back. */
function title(name: string | null, cwd: string | null): string {
    if (name !== null && name !== "") return name;
    const parts = cwd?.split(/[\\/]/).filter(Boolean) ?? [];
    return parts[parts.length - 1] ?? "Untitled";
}
