import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UsagePopover } from "@/routes/chat/components/session/UsagePopover";
import type { SessionStats } from "@/lib/protocol";

/**
 * The session's slots of the window's bar: the way to the session list, what the
 * session is called, and how full its context is.
 *
 * The bar itself, and the window's own keys at its end, are the window's
 * (`src/components/Window.tsx`); this is what a session puts in it.
 */
export function SessionHeader({
    name,
    cwd,
    stats,
    auto,
    expanded,
    onToggleSessions,
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
}) {
    return (
        <>
            <Button
                id="sidebar_toggle"
                variant="ghost"
                size="icon-sm"
                aria-label="Sessions"
                aria-expanded={expanded}
                onClick={onToggleSessions}
            >
                <Menu />
            </Button>
            <h1 id="session_name" className="text-title-sm min-w-0 flex-1 truncate px-2 text-center">
                {title(name, cwd)}
            </h1>
            <span id="session_controllers" className="flex shrink-0 items-center gap-1">
                <UsagePopover id="session-usage" stats={stats} auto={auto} />
            </span>
        </>
    );
}

/** The name pi holds, else the last part of the directory, as pi's own title falls back. */
function title(name: string | null, cwd: string | null): string {
    if (name !== null && name !== "") return name;
    const parts = cwd?.split(/[\\/]/).filter(Boolean) ?? [];
    return parts[parts.length - 1] ?? "Untitled";
}
