/**
 * The command panel of the composer: a list that floats above the message box while the
 * person types a command.
 *
 * The list is cmdk's — the pieces of shadcn's `command` this panel needs, kept in this
 * file because they are its own rather than a surface of `@/components/ui`. The keyboard
 * stays in the message box: the text typed there is the filter, so the panel takes no
 * input of its own, and the highlight is controlled from the outside for the same reason
 * (the arrows of the message box move it, and Enter chooses it — `composer/slash.ts`
 * builds the rows).
 *
 * A highlight that arrives as a controlled `value` is the one cmdk does not follow, so
 * the list scrolls to it itself; on every other path cmdk scrolls for its own keys.
 *
 * The panel is the design's: the popover plane under a 10% hairline, its own shadow, and
 * a list that scrolls past 320px.
 */

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { useLayoutEffect, useRef } from "react";
import { cn } from "cn";
import type { CommandRow } from "@/routes/chat/components/composer/slash";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            data-slot="command"
            className={cn(
                "bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-lg p-1",
                className,
            )}
            {...props}
        />
    );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
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
 * A row: `/name` and what pi wrote about it, both in one line.
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
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-lg px-2 py-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
                className,
            )}
            {...props}
        >
            {children}
        </CommandPrimitive.Item>
    );
}

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
    /**
     * Every row's element, by its value: cmdk writes no value to the DOM, and the row it
     * marks as selected is also the row the pointer is on.
     */
    const items = useRef(new Map<string, HTMLDivElement>());

    useLayoutEffect(() => {
        items.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
    }, [highlighted]);

    return (
        <Command
            id={id}
            // The panel filters nothing itself: the rows arrive filtered, because the
            // text that filters them lives in the message box.
            shouldFilter={false}
            value={highlighted}
            onValueChange={(value) => onHighlight(value === "" ? null : value)}
            className={cn(
                // Our own popover plane under its hairline, with the draft's 12px corner, its
                // `space-sm` of padding and a list that scrolls past 320px.
                "ring-foreground/10 max-h-80 gap-1 overflow-hidden rounded-xl p-2 shadow-md ring-1",
                className,
            )}
        >
            <CommandList id={`${id}-list`}>
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
                        // The row's shape is the primitive's; what it says about itself is the
                        // draft's: a quiet word, and the row under the keyboard in the ink the
                        // row in use would wear. The type ramp sits on the spans, where no
                        // colour class is there for tailwind-merge to lose it to.
                        className="text-muted-foreground"
                    >
                        <span className="text-body-md shrink-0 whitespace-nowrap">{row.label}</span>
                        {row.description !== null && (
                            <span className="text-body-md min-w-0 truncate">{row.description}</span>
                        )}
                    </CommandItem>
                ))}
            </CommandList>
        </Command>
    );
}
