/**
 * The thinking level of the session: a pill with a popup above it.
 *
 * The change is not kept here: the session reports it in the state of the session, and
 * the state is read again after the call. The four levels of thinking are a plain list
 * of four rows, 11rem wide, in the words of pi.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command as CommandPrimitive } from "cmdk";
import { Brain, Check } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { ScrollPane } from "@/components";
import * as bridge from "@/lib/bridge";
import type { ModelThinkingLevel } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";

export interface ThinkingLevelPickerProps {
    /** The session whose thinking level this changes. */
    session: string;
    /** The level that is active, from the state of the session. */
    current: ModelThinkingLevel | null;
    /** Whether the popup is open. The caller holds this, so one popup is open at a time. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function ThinkingLevelPicker({ session, current, open, onOpenChange }: ThinkingLevelPickerProps) {
    const client = useQueryClient();
    const levels = useQuery({ ...sessionQueries.thinkingLevels(session), enabled: open });
    const available = levels.data?.levels ?? [];
    const value = current ?? null;

    /** Every row's element, by its value: cmdk writes no value to the DOM, and the row it
     *  marks as selected is also the row the pointer is on. */
    const rows = useRef(new Map<string, HTMLDivElement>());

    // The row in use is kept in view here, not by cmdk: cmdk scrolls for the keys it
    // handles itself, while this highlight is set by the value the caller holds, which
    // cmdk takes without following it.
    useLayoutEffect(() => {
        if (value !== null) rows.current.get(value)?.scrollIntoView({ block: "nearest" });
    }, [value]);

    const choose = (chosen: string) => {
        const level = available.find((candidate) => candidate === chosen);
        if (level === undefined || chosen === value) return;
        void bridge
            .setThinkingLevel(session, level)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    };

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <Button
                    id="composer-thinking"
                    variant="ghost"
                    size="sm"
                    aria-label="Choose the thinking level"
                    // The pill grows with its label; below `sm` the label is gone
                    // and the key is the 32px circle of the other composer keys.
                    className={cn(
                        "border-border-strong bg-surface-container-highest",
                        "text-foreground hover:bg-surface-bright",
                        "aria-expanded:bg-surface-container-highest h-8",
                        "shrink-0 gap-2 rounded-full border px-3 max-sm:w-8",
                        "max-sm:justify-center max-sm:px-0",
                    )}
                >
                    <Brain className="size-4 shrink-0" />
                    <span className="text-label-lg hidden max-w-40 truncate sm:block">{current ?? "Thinking"}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                id="composer-thinking-popup"
                side="top"
                align="center"
                sideOffset={12}
                className={cn(
                    "elevation-raised bg-card text-foreground mx-2",
                    "flex max-h-60 w-44 flex-col gap-1 overflow-hidden p-2",
                )}
            >
                <CommandPrimitive
                    // The four levels are a plain list: nothing to search.
                    shouldFilter={false}
                    defaultValue={value ?? undefined}
                    label="Choose the thinking level"
                    className="flex min-h-0 flex-1 flex-col gap-1"
                >
                    <ScrollPane id="composer-thinking-scroll" className="min-h-0 flex-1">
                        <CommandPrimitive.List className="flex min-h-0 flex-col outline-none [&>div]:flex [&>div]:flex-col [&>div]:gap-1">
                            <CommandPrimitive.Empty className="text-muted-foreground text-body-md py-2 text-center">
                                No match.
                            </CommandPrimitive.Empty>
                            {available.map((level) => {
                                const inUse = level === value;
                                return (
                                    <CommandPrimitive.Item
                                        key={level}
                                        value={level}
                                        ref={(element) => {
                                            if (element) rows.current.set(level, element);
                                            else rows.current.delete(level);
                                        }}
                                        onSelect={() => {
                                            onOpenChange(false);
                                            choose(level);
                                        }}
                                        className={cn(
                                            "text-muted-foreground flex cursor-default items-center gap-2",
                                            "rounded-lg px-2 py-2 outline-hidden select-none",
                                            "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                                            inUse && "bg-accent text-accent-foreground font-medium",
                                        )}
                                    >
                                        <span className="text-body-md min-w-0 flex-1 truncate">{level}</span>
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
