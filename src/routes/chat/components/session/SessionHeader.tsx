import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UsagePopover } from "@/routes/chat/components/session/UsagePopover";
import type { SessionStats } from "@/lib/protocol";

/**
 * The bar over a session: what it is called, and how full its context is.
 *
 * The two flanks hold the same width, so the name sits in the middle of the bar
 * whatever either side carries. The left one carries the way to the session list
 * while that list is not a column of its own; from `lg` the column is always
 * there and the key is not drawn.
 */
export function SessionHeader({
    id,
    name,
    cwd,
    stats,
    auto,
    onOpenSessions,
}: {
    id: string;
    name: string | null;
    /** The directory the session runs in, for a session pi has no name for. */
    cwd: string | null;
    stats: SessionStats | null;
    auto: boolean;
    /** Opens the session list, for a window too narrow to hold it beside this bar. */
    onOpenSessions: () => void;
}) {
    return (
        <header id={id} className="bg-card border-border flex shrink-0 items-center border-b px-3 py-2">
            <div className="flex flex-1 basis-0 items-center">
                <Button
                    id={`${id}-sessions`}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Sessions"
                    onClick={onOpenSessions}
                    className="lg:hidden"
                >
                    <Menu />
                </Button>
            </div>
            <h1 className="text-title-sm min-w-0 shrink truncate px-2 text-center">{title(name, cwd)}</h1>
            <div className="flex flex-1 basis-0 items-center justify-end">
                <UsagePopover id={`${id}-usage`} stats={stats} auto={auto} />
            </div>
        </header>
    );
}

/** The name pi holds, else the last part of the directory, as pi's own title falls back. */
function title(name: string | null, cwd: string | null): string {
    if (name !== null && name !== "") return name;
    const parts = cwd?.split(/[\\/]/).filter(Boolean) ?? [];
    return parts[parts.length - 1] ?? "Untitled";
}
