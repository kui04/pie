/**
 * The command panel of the composer: a list that floats above the message box while the
 * person types a command.
 *
 * The list is cmdk's — the pieces of shadcn's `command` this panel needs, kept in this
 * file because they are its own rather than a surface of `@/components/ui`. The keyboard
 * stays in the message box: the text typed there is the filter, so the panel takes no
 * input of its own, and the highlight is controlled from the outside for the same reason
 * (the arrows of the message box move it, and Enter chooses it — `composer/command.ts`
 * builds the rows).
 *
 * A highlight that arrives as a controlled `value` is the one cmdk does not follow, so
 * the list scrolls to it itself; on every other path cmdk scrolls for its own keys.
 *
 * The panel is the design's: the surface of the composer's other popovers - the
 * composer's own plane, a `rounded-lg` corner, `space-sm` of padding and the raised
 * elevation - with a scroll pane inside, and ten rows before it scrolls.
 */

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { useLayoutEffect, useRef } from "react";
import { cn } from "cn";
import { PopoverContent } from "@/components/ui";
import { ScrollPane } from "@/components";
import type { CommandRow } from "@/routes/chat/composer/command";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            data-slot="command"
            // The panel around it owns the plane and the padding; this is the layout
            // of the list inside it.
            className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
            {...props}
        />
    );
}

function CommandRows({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
    return (
        <CommandPrimitive.List
            data-slot="command-list"
            className={cn(
                "flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto outline-none",
                // cmdk wraps the rows in a sizer of its own, so the gap the draft puts
                // between rows belongs to that wrapper, not to the scroller.
                "[&>div]:flex [&>div]:flex-col [&>div]:gap-1",
                className,
            )}
            {...props}
        />
    );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
    return (
        <CommandPrimitive.Empty
            data-slot="command-empty"
            className={cn("text-muted-foreground py-2 text-center text-sm", className)}
            {...props}
        />
    );
}

/**
 * A row: `/name` and what it says about itself, both in one line. Every row is a
 * command of the same shape (`composer/command.ts` builds the name and the words).
 *
 * cmdk writes `data-selected="false"` on every row it is not on, so the variant names
 * the value: a bare `data-selected:` would match the whole list and fill the rows the
 * reader is not on. The fill of the row under the keyboard is the house `accent`
 * (`selected-row`), and the row's shape is the draft's: as wide as the panel, 8px in from
 * its edge.
 */
function CommandItem({ className, children, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive.Item>) {
    return (
        <CommandPrimitive.Item
            data-slot="command-item"
            className={cn(
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                "relative flex cursor-default items-center gap-2",
                "rounded-lg px-2 py-2 text-sm outline-hidden select-none",
                "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
                className,
            )}
            {...props}
        >
            {children}
        </CommandPrimitive.Item>
    );
}

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
     * Every row's element, by its value: cmdk writes no value to the DOM, and the row it
     * marks as selected is also the row the pointer is on.
     */
    const items = useRef(new Map<string, HTMLDivElement>());

    useLayoutEffect(() => {
        items.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
    }, [highlighted]);

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
            <Command
                // The panel filters nothing itself: the rows arrive filtered, because
                // the text that filters them lives in the message box.
                shouldFilter={false}
                value={highlighted}
                onValueChange={(value) => onHighlight(value === "" ? null : value)}
                label="Commands"
            >
                <ScrollPane id={`${id}-scroll`} className="min-h-0 flex-1">
                    <CommandRows id={`${id}-list`}>
                        {rows.length === 0 && <CommandEmpty>No command here.</CommandEmpty>}
                        {rows.map((row) => (
                            <CommandItem
                                key={row.id}
                                value={row.id}
                                ref={(element) => {
                                    if (element) items.current.set(row.id, element);
                                    else items.current.delete(row.id);
                                }}
                                onSelect={() => onChoose(row)}
                                // The row's shape is the primitive's; the ink is the draft's,
                                // and it is two tones: the name is what the reader reads, so
                                // it stays on the panel's own ink (`foreground`), while the
                                // description recedes. The type ramp sits on the spans,
                                // where no colour class is there for tailwind-merge to lose
                                // it to.
                                className="group/item"
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
                            </CommandItem>
                        ))}
                    </CommandRows>
                </ScrollPane>
            </Command>
        </PopoverContent>
    );
}
