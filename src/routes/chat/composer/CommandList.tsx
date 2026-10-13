/**
 * The command panel of the composer: a list that floats above the message box while the
 * person types a command.
 *
 * The list is pie's own and not a list widget's: the keyboard lives in the message box,
 * whose text is the filter, so the panel takes no input of its own and the highlight
 * arrives as a controlled id (the arrows of the message box move it, and Enter chooses it -
 * `composer/command.ts` builds the rows). A widget would be asked for one thing here, a row
 * with a highlight on it, which is the same thing the model popup's rows draw themselves.
 *
 * The highlight arrives from outside, so the list scrolls to it itself.
 *
 * The panel is the design's: the surface of the composer's other popovers - the
 * composer's own plane, a `rounded-lg` corner, `space-sm` of padding and the raised
 * elevation - with a scroll pane inside, and ten rows before it scrolls.
 */

import { useRef } from "react";
import { cn } from "cn";
import { PopoverContent } from "@/components/ui";
import { ScrollPane } from "@/components";
import type { CommandRow } from "@/routes/chat/composer/command";

export interface CommandListProps {
    /** The base of the ids of this panel. */
    id: string;
    /** The rows to show, already filtered by what was typed. */
    rows: CommandRow[];
    /** The id of the row under the keyboard. */
    highlighted: string;
    onHighlight: (id: string | null) => void;
    onChoose: (row: CommandRow) => void;
    /** Merged into the panel last, for a caller that moves it. */
    className?: string;
}

export function CommandList({ id, rows, highlighted, onHighlight, onChoose, className }: CommandListProps) {
    /**
     * The row the list has already brought into view. The rows mount with the popup's
     * portal, a commit after this panel does, so a layout effect of its own would run
     * before there is a row to scroll to: a row scrolls itself into view as it is
     * attached instead, once for each highlight.
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
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // The panel is as wide as the card it stands above, which is what the
            // composer anchors this popover to. The height is ten rows (36px each),
            // the nine 4px gaps between them, and this padding - 412px, the 103 steps
            // of the spacing unit - so the list scrolls past what the panel shows and
            // no further.
            className={cn(
                "elevation-raised bg-card text-foreground max-h-103",
                "w-(--radix-popover-trigger-width) gap-1 overflow-hidden p-2",
                className,
            )}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-1">
                <ScrollPane id={`${id}-scroll`} className="min-h-0 flex-1">
                    <div
                        role="listbox"
                        id={`${id}-list`}
                        aria-label="Commands"
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
                                aria-selected={row.id === highlighted}
                                data-selected={row.id === highlighted}
                                ref={(element) => hold(row, element)}
                                onClick={() => onChoose(row)}
                                onMouseMove={() => onHighlight(row.id)}
                                // The row is two tones: the name is what the reader reads,
                                // so it stays on the panel's own ink (`foreground`), while
                                // the description recedes. The type ramp sits on the spans,
                                // where no colour class is there for tailwind-merge to lose
                                // it to.
                                className={cn(
                                    "group/item",
                                    "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                                    "relative flex cursor-default items-center gap-2",
                                    "rounded-lg px-2 py-2 text-sm select-none",
                                )}
                            >
                                <span className="text-body-md shrink-0 whitespace-nowrap">/{row.name}</span>
                                {row.description !== null && (
                                    // The description follows the selection too, and not as a
                                    // decoration: `muted-foreground` on the `accent` fill is
                                    // 4.37:1, under the 4.5 a sentence needs.
                                    <span className="text-body-md text-muted-foreground group-data-[selected=true]/item:text-accent-foreground min-w-0 truncate">
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
