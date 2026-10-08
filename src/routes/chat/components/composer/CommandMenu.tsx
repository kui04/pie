/**
 * The command panel of the composer: a list that floats above the message box while
 * the person types a command.
 *
 * The list is cmdk's (the `Command` of shadcn), and the keyboard stays in the
 * message box: the text typed there is the filter, so the panel takes no input of its
 * own. The highlight is controlled from the outside for the same reason — the arrows
 * of the message box move it, and Enter chooses it (`composer/slash.ts` builds the
 * rows).
 *
 * The panel is the design's: the card's width, one small gap above the card, its own
 * chrome and shadow, and a list that scrolls past 320px.
 */

import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "cn";
import type { CommandRow } from "@/routes/chat/components/composer/slash";

export interface CommandMenuProps {
    /** The base of the ids of this panel. */
    id: string;
    /** The rows to show, already filtered by what was typed. */
    rows: CommandRow[];
    /** The id of the row under the keyboard. */
    highlighted: string;
    onHighlight: (id: string | null) => void;
    onChoose: (row: CommandRow) => void;
    /** Placement of this panel, from the message box it belongs to. */
    className?: string;
}

export function CommandMenu({ id, rows, highlighted, onHighlight, onChoose, className }: CommandMenuProps) {
    return (
        <Command
            id={id}
            // The panel filters nothing itself: the rows arrive filtered, because the
            // text that filters them lives in the message box.
            shouldFilter={false}
            value={highlighted}
            onValueChange={(value) => onHighlight(value === "" ? null : value)}
            className={cn(
                "border-border-strong bg-surface-container max-h-80 gap-0 overflow-hidden rounded-xl border p-2 shadow-md",
                className,
            )}
        >
            <CommandList id={`${id}-list`} className="max-h-72">
                {rows.length === 0 && (
                    <CommandEmpty className="text-muted-foreground text-body-md py-2 text-center">
                        No command here.
                    </CommandEmpty>
                )}
                {rows.map((row) => (
                    <CommandItem
                        key={row.id}
                        value={row.id}
                        onSelect={() => onChoose(row)}
                        className={cn(
                            "text-body-md w-full items-center gap-2 rounded-lg px-2 py-2",
                            "text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-foreground",
                        )}
                    >
                        <span className="shrink-0 whitespace-nowrap">{row.label}</span>
                        {row.description !== null && (
                            <span className="text-body-md min-w-0 truncate">{row.description}</span>
                        )}
                    </CommandItem>
                ))}
            </CommandList>
        </Command>
    );
}
