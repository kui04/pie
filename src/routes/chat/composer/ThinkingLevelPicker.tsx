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
import { Popover, PopoverContent, PopoverTrigger, Skeleton } from "@/components/ui";
import * as bridge from "@/lib/bridge";
import type { ModelThinkingLevel } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";
import { Icon } from "@/components";
import { COMPOSER_PANEL, PickerPill } from "@/routes/chat/composer/Composer";

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
            <PopoverTrigger
                render={
                    <PickerPill
                        id="composer-thinking"
                        aria-label="Choose the thinking level"
                        className="max-w-32 shrink-0 max-sm:max-w-26"
                    />
                }
            >
                <Icon className="size-4 shrink-0">
                    <Brain />
                </Icon>
                <span className="min-w-0 truncate">{current ?? "Thinking"}</span>
            </PopoverTrigger>
            <PopoverContent
                id="composer-thinking-popup"
                side="top"
                align="center"
                sideOffset={12}
                className={cn(
                    `
                        mx-2 flex max-h-[min(15rem,calc(100dvh-12rem))] w-44 flex-col gap-1 overflow-hidden rounded-xl
                        p-2 text-foreground
                    `,
                    COMPOSER_PANEL,
                )}
            >
                {levels.isPending ? (
                    <LevelSkeleton />
                ) : levels.isError ? (
                    <p className="px-2 py-4 text-center text-body-md text-muted-foreground">
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
                <div key={row} aria-hidden className="flex items-center gap-2 rounded-lg p-2">
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
 * The rows and the light over them, the same rule as the model popup: nothing is lit until the
 * pointer or a key moves the light; it leaves with the pointer, and it opens on no row at all
 * - a level is not lit for being the one in use, which its check says. The arrows walk the list
 * and wrap, and Enter with nothing lit keeps the level in use.
 */
function LevelList({ levels, value, onChoose }: LevelListProps) {
    const listId = `${useId()}-levels`;
    const [cursor, setCursor] = useState<number | null>(null);
    const [hovered, setHovered] = useState<number | null>(null);
    // Nothing is lit until the pointer or a key moves the light, and the level in use is
    // marked by its check alone - the same rule as the model popup.
    const at = cursor ?? -1;
    const lit = levels.length === 0 ? -1 : Math.min(hovered ?? at, levels.length - 1);

    useLayoutEffect(() => {
        document.getElementById(`${listId}-${lit}`)?.scrollIntoView({ block: "nearest" });
    }, [lit, listId]);

    const move = (step: number) => {
        if (levels.length === 0) return;
        // A key takes the light from the pointer, and stands where the keyboard left it.
        setHovered(null);
        setCursor((current) => {
            if (current === null) return step > 0 ? 0 : levels.length - 1;
            return (current + step + levels.length) % levels.length;
        });
    };

    return (
        <div
            // The list takes the focus of the popup, so the keys of the list arrive here.
            role="listbox"
            id={listId}
            aria-label="Choose the thinking level"
            aria-activedescendant={lit < 0 ? undefined : `${listId}-${lit}`}
            tabIndex={0}
            autoFocus
            onMouseLeave={() => setHovered(null)}
            onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                    event.preventDefault();
                    move(1);
                } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    move(-1);
                } else if (event.key === "Enter") {
                    // With nothing lit, the key keeps the level in use - it does not take the
                    // first row of the list.
                    const level = lit < 0 ? (value ?? undefined) : levels[lit];
                    if (level !== undefined && level !== null) {
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
                    aria-selected={index === lit}
                    data-lit={index === lit}
                    onClick={() => onChoose(level)}
                    onMouseMove={() => setHovered(index)}
                    className="
                        flex cursor-default items-center gap-2 rounded-lg p-2 text-foreground transition-colors
                        select-none
                        data-[lit=true]:bg-accent
                    "
                >
                    <span className="min-w-0 flex-1 truncate text-body-md">{level}</span>
                    {level === value && (
                        <Icon className="shrink-0 text-primary-text">
                            <Check aria-label="In use" />
                        </Icon>
                    )}
                </div>
            ))}
        </div>
    );
}
