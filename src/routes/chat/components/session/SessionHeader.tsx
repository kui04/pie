import { AnimatePresence, motion } from "motion/react";
import { UsagePopover } from "@/routes/chat/components/session/UsagePopover";
import { SidebarToggle } from "@/routes/chat/components/session/SidebarToggle";
import { STAGE, STAGE_ARRIVE, STAGE_LEAVE, STAGE_SETTLED } from "@/lib/motion";
import type { SessionStats } from "@/lib/rpc-protocol";

/**
 * The session's slots of the window's bar: the way to the session list, what the
 * session is called, and how full its context is.
 *
 * The bar itself, and the window's own keys at its end, are the window's
 * (`src/components/layout/Window.tsx`); this is what a session puts in it. While the
 * conversation is still on its way it has nothing to say about itself, so only
 * the way to the list stands: its slots arrive with the words.
 */
export function SessionHeader({
    name,
    cwd,
    stats,
    auto,
    expanded,
    onToggleSessions,
    ready = true,
}: {
    name: string | null;
    /** The directory the session runs in, for a session pi has no name for. */
    cwd: string | null;
    stats: SessionStats | null;
    auto: boolean;
    /** Whether the list is out beside the chat; undefined where it is a sheet. */
    expanded?: boolean;
    /** Folds the column away, or opens the sheet that holds the list. */
    onToggleSessions: () => void;
    /** Whether the conversation has arrived; its slots wait for it until it has. */
    ready?: boolean;
}) {
    return (
        <>
            <SidebarToggle expanded={expanded} onToggleSessions={onToggleSessions} />
            <AnimatePresence initial={false}>
                {ready && (
                    <motion.div
                        initial={STAGE_ARRIVE}
                        animate={STAGE_SETTLED}
                        exit={STAGE_LEAVE}
                        transition={STAGE}
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
        </>
    );
}

/** The name pi holds, else the last part of the directory, as pi's own title falls back. */
function title(name: string | null, cwd: string | null): string {
    if (name !== null && name !== "") return name;
    const parts = cwd?.split(/[\\/]/).filter(Boolean) ?? [];
    return parts[parts.length - 1] ?? "Untitled";
}
