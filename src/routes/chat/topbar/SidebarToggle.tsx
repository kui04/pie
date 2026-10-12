import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui";

/**
 * The way to the session list: the leading key of the bar.
 *
 * It is what the bar carries while no conversation is shown (the landing, and
 * the loading of one), and what a session's own slots start with.
 */
export function SidebarToggle({
    expanded,
    onToggleSessions,
}: {
    /** Whether the list is out beside the chat; undefined where it is a sheet. */
    expanded?: boolean;
    /** Folds the column away, or opens the sheet that holds the list. */
    onToggleSessions: () => void;
}) {
    return (
        <Button
            id="sidebar_toggle"
            variant="ghost"
            size="icon-sm"
            aria-label="Sessions"
            aria-expanded={expanded}
            onClick={onToggleSessions}
            // The icon is what says whether the list is out beside the chat, so the key
            // does not fill for it: the ghost variant would fill an expanded key.
            className="aria-expanded:bg-transparent"
        >
            {/* What the press does: it folds a column that is out, and opens the sheet
                that holds the list where there is no column. */}
            {expanded === true ? <PanelLeftClose /> : <PanelLeftOpen />}
        </Button>
    );
}
