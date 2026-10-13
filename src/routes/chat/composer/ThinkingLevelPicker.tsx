/**
 * The thinking level of the session: a pill with a popup above it.
 *
 * The change is not kept here: the session reports it in the state of the session, and
 * the state is read again after the call. The four levels of thinking are a plain list
 * of four rows, 11rem wide, in the words of pi.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check } from "lucide-react";
import { useId, useLayoutEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from "@/components/ui";
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
                {levels.isPending ? (
                    <LevelSkeleton />
                ) : levels.isError ? (
                    <p className="text-muted-foreground text-body-md px-2 py-4 text-center">
                        Could not read the thinking levels.
                    </p>
                ) : (
                    <LevelList
                        levels={available}
                        value={value}
                        onChoose={(level) => {
                            onOpenChange(false);
                            choose(level);
                        }}
                    />
                )}
            </PopoverContent>
        </Popover>
    );
}

/**
 * The rows of the popup before the levels arrive: the layout a row takes, drawn as bars, so the
 * popup opens at the height it keeps. A level is one word and carries no mark - the check of
 * the level in use is not drawn while it is unknown - so a row is one bar.
 */
function LevelSkeleton() {
    return (
        <div role="status" aria-label="Loading the thinking levels" className="flex flex-col gap-1">
            {WIDTHS.map((width, row) => (
                <div key={row} aria-hidden className="flex items-center gap-2 rounded-lg px-2 py-2">
                    <Skeleton className={cn("h-5", width, "motion-reduce:animate-none")} />
                </div>
            ))}
        </div>
    );
}

/** The width of each bar, one row after another: four levels, four rows. */
const WIDTHS = ["w-2/5", "w-1/3", "w-3/5", "w-1/2"];

interface LevelListProps {
    /** Every level the session offers, as pi reported them. */
    levels: readonly ModelThinkingLevel[];
    /** The level in use. */
    value: ModelThinkingLevel | null;
    onChoose: (level: ModelThinkingLevel) => void;
}

/**
 * The rows and the cursor over them. Four levels need no search and no widget: the cursor
 * opens on the level in use, the arrows walk the list and wrap, and Enter takes the row the
 * cursor stands on - the behaviour of the model popup, whose rows are drawn the same way.
 */
function LevelList({ levels, value, onChoose }: LevelListProps) {
    const listId = `${useId()}-levels`;
    const [cursor, setCursor] = useState(() =>
        Math.max(
            0,
            levels.findIndex((level) => level === value),
        ),
    );

    useLayoutEffect(() => {
        document.getElementById(`${listId}-${cursor}`)?.scrollIntoView({ block: "nearest" });
    }, [cursor, listId]);

    const move = (step: number) => {
        if (levels.length === 0) return;
        setCursor((current) => (current + step + levels.length) % levels.length);
    };

    return (
        <div
            // The list takes the focus of the popup, so the keys of the list arrive here.
            role="listbox"
            id={listId}
            aria-label="Choose the thinking level"
            aria-activedescendant={levels.length === 0 ? undefined : `${listId}-${cursor}`}
            tabIndex={0}
            autoFocus
            onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                    event.preventDefault();
                    move(1);
                } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    move(-1);
                } else if (event.key === "Enter") {
                    const level = levels[cursor];
                    if (level !== undefined) {
                        event.preventDefault();
                        onChoose(level);
                    }
                }
            }}
            className="flex min-h-0 flex-1 flex-col gap-1 outline-none"
        >
            {levels.map((level, index) => (
                <div
                    key={level}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === cursor}
                    data-selected={index === cursor}
                    onClick={() => onChoose(level)}
                    onMouseMove={() => setCursor(index)}
                    className={cn(
                        "text-muted-foreground flex cursor-default items-center gap-2",
                        "rounded-lg px-2 py-2 select-none",
                        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                        level === value && "bg-accent text-accent-foreground font-medium",
                    )}
                >
                    <span className="text-body-md min-w-0 flex-1 truncate">{level}</span>
                    {level === value && <Check className="text-primary-text size-4 shrink-0" aria-label="In use" />}
                </div>
            ))}
        </div>
    );
}
