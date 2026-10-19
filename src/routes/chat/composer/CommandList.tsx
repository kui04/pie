/**
 * The command panel of the composer: a list that floats above the message box while the person
 * types a command.
 *
 * The keyboard lives in the message box, whose text is the filter: the panel takes no input of
 * its own, the row that is lit is the pointer's or the keyboard's, and the row the keyboard is
 * on is the one it keeps in view.
 */

import { useRef } from "react";
import { cn } from "cn";
import { ScrollPane } from "@/components";
import { PopoverContent } from "@/components/ui";
import type { CommandRow } from "@/routes/chat/composer/command";

export interface CommandListProps {
    /** The base of the ids of this panel. */
    id: string;
    /** The rows to show, already filtered by what was typed. */
    rows: CommandRow[];
    /** The id of the row under the keyboard, which is the row kept in view. */
    highlighted: string;
    /** The id of the row that is lit: the row under the pointer, or the keyboard's. */
    lit: string;
    /** Called with the row the pointer entered, and with `null` when it leaves the list. */
    onPoint: (id: string | null) => void;
    onChoose: (row: CommandRow) => void;
    /** Merged into the panel last, for a caller that moves it. */
    className?: string;
}

/**
 * How many rows the panel shows before it scrolls: ten of them, 36px each with 4px
 * between, which is what the height below is made of.
 */
const TEN_ROWS = 10;

export function CommandList({ id, rows, highlighted, lit, onPoint, onChoose, className }: CommandListProps) {
    /**
     * The row the list has already brought into view. The rows mount with the popup's
     * portal, a commit after this panel does, so a layout effect of its own would run
     * before there is a row to scroll to: a row scrolls itself into view as it is
     * attached instead, once for each row the keyboard moves to. The pointer never scrolls
     * the list: a row it is over is already under it.
     */
    const brought = useRef<string | null>(null);

    const hold = (row: CommandRow, element: HTMLDivElement | null) => {
        if (element === null) return;
        if (row.id === highlighted && brought.current !== highlighted) {
            brought.current = highlighted;
            element.scrollIntoView({ block: "nearest" });
        }
    };

    return (
        <PopoverContent
            id={id}
            side="top"
            align="center"
            sideOffset={8}
            // The box keeps the keyboard: the text that filters this list is typed in
            // the message box, and a popover that took the focus would end the typing.
            initialFocus={false}
            finalFocus={false}
            // The panel is as wide as the card it stands above. Ten rows (36px each), the
            // nine 4px gaps between them and this padding are 412px, the 103 steps of the
            // spacing unit: the height is set past the tenth row and left off while there are
            // fewer, so a short panel is not ten rows of air. A cap alone would not do - the
            // scroll area's viewport takes its height from the panel, and a percentage against
            // a capped parent stays as tall as its content, so the rows past the tenth would be
            // clipped rather than scrolled to.
            className={cn(
                "bg-card text-foreground elevation-raised",
                // The cap follows the visible viewport, so an open keyboard
                // cannot push the rows off screen; the scroll pane takes the rest.
                "max-h-[calc(100dvh-14rem)]",
                rows.length > TEN_ROWS && "h-103",
                "w-(--anchor-width) gap-1 overflow-hidden p-2",
                className,
            )}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-1">
                <ScrollPane id={`${id}-scroll`} className="min-h-0 flex-1">
                    <div
                        role="listbox"
                        id={`${id}-list`}
                        aria-label="Commands"
                        onMouseLeave={() => onPoint(null)}
                        className="flex min-h-0 flex-col gap-1 outline-none"
                    >
                        {rows.map((row) => (
                            <div
                                key={row.id}
                                // The id of a row is the id of the panel and the id of the
                                // row: the message box names the row under the keyboard
                                // with it.
                                id={`${id}-${row.id}`}
                                role="option"
                                aria-selected={row.id === lit}
                                data-lit={row.id === lit}
                                ref={(element) => hold(row, element)}
                                onClick={() => onChoose(row)}
                                onMouseMove={() => onPoint(row.id)}
                                // The row is two tones: the name is what the reader reads,
                                // so it stays on the panel's own ink (`foreground`), while
                                // the description recedes. The type ramp sits on the spans,
                                // where no colour class is there for tailwind-merge to lose
                                // it to.
                                className={cn(
                                    "group/item",
                                    "data-[lit=true]:bg-accent data-[lit=true]:text-accent-foreground",
                                    "relative flex cursor-default items-center gap-2",
                                    "rounded-lg p-2 text-sm select-none",
                                )}
                            >
                                <span className="shrink-0 text-body-md whitespace-nowrap">/{row.name}</span>
                                {row.description !== null && (
                                    // The description follows the selection too, and not as a
                                    // decoration: `muted-foreground` on the `accent` fill is
                                    // 4.37:1, under the 4.5 a sentence needs.
                                    <span className="min-w-0 truncate text-body-md text-muted-foreground group-data-[lit=true]/item:text-accent-foreground">
                                        {row.description}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </ScrollPane>
            </div>
        </PopoverContent>
    );
}
