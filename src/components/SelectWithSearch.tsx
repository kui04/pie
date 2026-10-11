import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, Search } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollPane } from "@/components/ScrollPane";
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
                    className="border-border-strong bg-surface-container-highest text-foreground hover:bg-surface-bright aria-expanded:bg-surface-container-highest h-8 w-8 shrink-0 gap-2 rounded-full border px-3 max-[600px]:justify-center max-[600px]:px-0"
                >
                    {icon}
                    <span className="text-label-lg hidden max-w-40 truncate min-[600px]:block">{label}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                id={`${id}-popup`}
                side="top"
                align="center"
                sideOffset={12}
                className={cn("mx-2 gap-1 rounded-xl p-2", "flex max-h-60 flex-col overflow-hidden", className)}
            >
                <CommandPrimitive
                    shouldFilter={search !== undefined}
                    defaultValue={value ?? undefined}
                    label={ariaLabel}
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
                    <ScrollPane id={`${id}-scroll`} className="min-h-0 flex-1">
                        <CommandPrimitive.List className="flex min-h-0 flex-col outline-none [&>div]:flex [&>div]:flex-col [&>div]:gap-1">
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
                                            "text-muted-foreground flex cursor-default items-center gap-2 rounded-lg px-2 py-2 outline-hidden select-none",
                                            "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                                            inUse && "bg-accent text-accent-foreground font-medium",
                                        )}
                                    >
                                        <span className="text-body-md min-w-0 flex-1 truncate">{choice.label}</span>
                                        {inUse && (
                                            <Check className="text-primary-text size-4 shrink-0" aria-label="In use" />
                                        )}
                                    </CommandPrimitive.Item>
                                );
                            })}
                        </CommandPrimitive.List>
                    </ScrollPane>
                </CommandPrimitive>
            </PopoverContent>
        </Popover>
    );
}
