/**
 * A pill that opens a list of choices above it, with a search row when one is asked for.
 *
 * The layout is the draft's (`.ui-design/components/composer`, situations 3 and 4): the
 * popup hangs `space-md` above the pill and is centred on it, is padded `space-sm` with
 * `space-xs` between the search row and the list, carries a 12px corner, and its rows are
 * padded `space-sm`, `space-xs` apart, each as wide as the popup with the check at its own
 * end. Its colours are ours: the popover plane under the layer's 10% hairline, and rows in
 * the accent of `selected-row` - the row under the pointer or the keyboard, and the row in
 * use, which also carries the check.
 *
 * The search row is optional: the model popup has one - the list of models is long enough
 * to be searched - while the four levels of thinking need none. The list is the scroller,
 * so the search row stays where it is put; a popup that must not change height whatever
 * the choices are is given one.
 */

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, Search } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";

/** One choice of a select. */
export interface SelectChoice {
    /** What the choice is worth: what the caller hears when it is chosen. */
    value: string;
    /** What the row says. */
    label: string;
    /** Other words that find it, for the search row. */
    keywords?: string[];
}

export interface SelectWithSearchProps {
    id: string;
    /** The pill's own word, and what a screen reader calls the key. */
    label: string;
    ariaLabel: string;
    icon: React.ReactNode;
    /** The choice in use: its row carries the check, and the list opens on it. */
    value: string | null;
    choices: SelectChoice[];
    onChoose: (value: string) => void;
    /** The popup that is open, if any: the caller holds which one. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The search row's own word; a popup without one has no search at all. */
    search?: string;
    /** The popup's own classes, for the width the draft gives a panel. */
    className?: string;
}

/** The pill both pickers open from: 32px, a hairline, the word from 600px up. */
const PILL =
    // The key's own chrome, not the field a select primitive would draw, and the plane its
    // neighbours hover on. One pass of classes is enough: the ghost variant carries no
    // `dark:` background of its own, so this one holds in either theme. Its expanded fill is
    // named again as the same plane - the ghost variant would paint `--muted` there, and the
    // popup above the pill is what says it is open.
    "border-border-strong bg-surface-container-highest text-foreground hover:bg-surface-bright aria-expanded:bg-surface-container-highest h-8 shrink-0 gap-2 rounded-full border px-3";

export function SelectWithSearch({
    id,
    label,
    ariaLabel,
    icon,
    value,
    choices,
    onChoose,
    open,
    onOpenChange,
    search,
    className,
}: SelectWithSearchProps) {
    /** Every row's element, by its value: cmdk writes no value to the DOM, and the row it
     *  marks as selected is also the row the pointer is on. */
    const rows = useRef(new Map<string, HTMLDivElement>());

    // The row under the keyboard is kept in view here, not by cmdk: cmdk scrolls for the
    // keys it handles itself, while this highlight is set by the value the caller holds,
    // which cmdk takes without following it.
    useLayoutEffect(() => {
        if (value !== null) rows.current.get(value)?.scrollIntoView({ block: "nearest" });
    }, [value]);

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <Button
                    id={id}
                    variant="ghost"
                    size="sm"
                    aria-label={ariaLabel}
                    className={cn(PILL, "max-[600px]:justify-center max-[600px]:px-0")}
                >
                    {icon}
                    <span className="text-label-lg hidden max-w-40 truncate min-[600px]:block">{label}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                id={`${id}-popup`}
                side="top"
                align="center"
                // The draft's gap between a pill and its popup.
                sideOffset={12}
                className={cn(
                    // Our own popover plane under its hairline (`ring-foreground/10`), with the
                    // draft's 12px corner and its `space-sm` of padding.
                    "gap-1 rounded-xl p-2",
                    "flex max-h-60 flex-col overflow-hidden",
                    className,
                )}
            >
                <CommandPrimitive
                    // The filter of the list is the search row's own word; a popup with no
                    // row has nothing to filter.
                    shouldFilter={search !== undefined}
                    // The list opens on the choice in use, and names itself for the row of
                    // cmdk that carries the search (the input is cmdk's own combobox).
                    defaultValue={value ?? undefined}
                    label={ariaLabel}
                    // cmdk's root is a plain block: the stack of the search row over the list,
                    // and the gap between them. It is also what gives the list a height to
                    // scroll in: with the root left to size itself, the rows grow past the
                    // popup and are clipped instead.
                    className="flex min-h-0 flex-1 flex-col gap-1"
                >
                    {search !== undefined && (
                        <div className="border-border-strong bg-surface-container-highest flex items-center gap-2 rounded-lg border px-2 py-2">
                            <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
                            <CommandPrimitive.Input
                                placeholder={search}
                                className="text-body-md placeholder:text-outline min-w-0 flex-1 bg-transparent outline-hidden"
                            />
                        </div>
                    )}
                    {/* cmdk wraps the rows in a sizer of its own, so the gap between them
                        belongs to that wrapper, not to the scroller. */}
                    <CommandPrimitive.List className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto outline-none [&>div]:flex [&>div]:flex-col [&>div]:gap-1">
                        <CommandPrimitive.Empty className="text-muted-foreground text-body-md py-2 text-center">
                            No match.
                        </CommandPrimitive.Empty>
                        {choices.map((choice) => {
                            const inUse = choice.value === value;
                            return (
                                <CommandPrimitive.Item
                                    key={choice.value}
                                    value={choice.value}
                                    keywords={choice.keywords}
                                    ref={(element) => {
                                        if (element) rows.current.set(choice.value, element);
                                        else rows.current.delete(choice.value);
                                    }}
                                    onSelect={() => {
                                        onOpenChange(false);
                                        onChoose(choice.value);
                                    }}
                                    className={cn(
                                        // Our own row vocabulary: the row under the pointer, or the
                                        // row in use, takes the accent (`selected-row`), with a check in
                                        // the app's link ink for the one in use.
                                        "text-muted-foreground flex cursor-default items-center gap-2 rounded-lg px-2 py-2 outline-hidden select-none",
                                        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                                        inUse && "bg-accent text-accent-foreground font-medium",
                                    )}
                                >
                                    {/* The ramp on the span, where no colour class is there for
                                        tailwind-merge to lose it to. */}
                                    <span className="text-body-md min-w-0 flex-1 truncate">{choice.label}</span>
                                    {inUse && (
                                        <Check className="text-primary-text size-4 shrink-0" aria-label="In use" />
                                    )}
                                </CommandPrimitive.Item>
                            );
                        })}
                    </CommandPrimitive.List>
                </CommandPrimitive>
            </PopoverContent>
        </Popover>
    );
}
