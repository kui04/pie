/**
 * The two settings of a session that the composer can change: its model and its
 * thinking level.
 *
 * Each one is a round key of the control row with its own panel above it, centered on
 * the key (`align="center"`, `side="top"`): the draft's right-align scheme clips on a
 * narrow screen. The lists come from the session (`get_available_models`,
 * `get_available_thinking_levels`) and are read when the panel opens; the active
 * values come from the state of the session, which the change reports back through
 * `get_state`.
 *
 * The panels are the design's: `surface-container-high` under a hairline, radius
 * `xl`, the popup shadow; a row spans the panel and takes the next step of the ladder
 * when it is under the pointer. The model panel carries the search row the design
 * gives it; the thinking panel is four rows and nothing else. The value a row shows
 * is the value of pi, verbatim, and the row in use carries the check.
 *
 * One panel is open at a time: the caller holds which one, so a click on the other
 * key closes the first and opens the second.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Brain, Check, Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInputRaw,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";
import * as bridge from "@/lib/bridge";
import type { Model, ModelThinkingLevel } from "@/lib/protocol";
import { sessionQueries } from "@/lib/query";

/** Which panel of the composer is open, if any. */
export type ComposerPanel = "model" | "thinking" | null;

export interface ModePickersProps {
    /** The session whose model and thinking level these change. */
    session: string;
    /** The model that is active, from the state of the session. */
    model: Model | null;
    /** The thinking level that is active, from the state of the session. */
    thinking: ModelThinkingLevel | null;
    /** The panel that is open, if any. */
    panel: ComposerPanel;
    onOpenChange: (panel: ComposerPanel) => void;
}

export function ModePickers({ session, model, thinking, panel, onOpenChange }: ModePickersProps) {
    return (
        <>
            <ModelPicker session={session} current={model} open={panel === "model"} onOpenChange={onOpenChange} />
            <ThinkingPicker
                session={session}
                current={thinking}
                open={panel === "thinking"}
                onOpenChange={onOpenChange}
            />
        </>
    );
}

/** The round key both pickers share: 32px, a hairline, the label from 600px up. */
function PickerKey({
    id,
    label,
    ariaLabel,
    icon,
    className,
    ...props
}: { id: string; label: string; ariaLabel: string; icon: ReactNode } & ComponentProps<typeof Button>) {
    return (
        <Button
            id={id}
            variant="ghost"
            size="sm"
            aria-label={ariaLabel}
            className={cn(
                "border-border-strong bg-surface-container-highest text-foreground hover:bg-surface-bright hover:text-foreground h-8 shrink-0 gap-2 rounded-full border px-3",
                "max-[600px]:justify-center max-[600px]:px-0",
                className,
            )}
            {...props}
        >
            {icon}
            <span className="text-label-lg hidden max-w-40 truncate min-[600px]:block">{label}</span>
        </Button>
    );
}

/**
 * The panel both pickers share: the design's floating layer, one step above the card.
 */
function Panel({ id, className, children }: { id: string; className: string; children: ReactNode }) {
    return (
        <PopoverContent
            id={id}
            side="top"
            align="center"
            sideOffset={12}
            className={cn(
                "border-border-strong bg-surface-container-high max-h-60 gap-1 overflow-hidden rounded-xl border p-2 shadow-md",
                className,
            )}
        >
            {children}
        </PopoverContent>
    );
}

/** A row of a panel: as wide as the panel, and one step up when it is under the pointer. */
function Row({
    value,
    active,
    onSelect,
    children,
}: {
    value: string;
    active: boolean;
    onSelect: () => void;
    children: ReactNode;
}) {
    return (
        <CommandItem
            value={value}
            onSelect={onSelect}
            className={cn(
                "text-body-md w-full gap-2 rounded-lg px-2 py-2",
                "text-muted-foreground data-[selected=true]:bg-surface-container-highest data-[selected=true]:text-foreground data-[selected=true]:font-medium",
            )}
        >
            {children}
            {active && <Check className="text-primary-text size-4 shrink-0" aria-label="In use" />}
        </CommandItem>
    );
}

/**
 * The model of the session.
 *
 * The change is not kept here: the session reports it as a `model_change` entry and
 * as the model of its state, and the state is read again after the call.
 */
function ModelPicker({
    session,
    current,
    open,
    onOpenChange,
}: {
    session: string;
    current: Model | null;
    open: boolean;
    onOpenChange: (panel: ComposerPanel) => void;
}) {
    const client = useQueryClient();
    const models = useQuery({ ...sessionQueries.models(session), enabled: open });
    const available = models.data?.models ?? [];

    const choose = (model: Model) => {
        onOpenChange(null);
        if (current !== null && model.provider === current.provider && model.id === current.id) return;
        void bridge
            .setModel(session, model.provider, model.id)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    };

    return (
        <Popover open={open} onOpenChange={(next) => onOpenChange(next ? "model" : null)}>
            <PopoverTrigger asChild>
                <PickerKey
                    id="composer-model"
                    label={current?.name ?? "Model"}
                    ariaLabel="Choose the model"
                    icon={<Bot className="size-4 shrink-0" />}
                />
            </PopoverTrigger>
            <Panel id="composer-model-popup" className="w-[17rem]">
                <Command className="gap-1 bg-transparent p-0">
                    {/* The design gives this panel a search row and no other its. */}
                    <div className="border-border-strong bg-surface-container-highest flex items-center gap-2 rounded-lg border px-2 py-2">
                        <Search className="text-muted-foreground size-4 shrink-0" />
                        <CommandInputRaw id="composer-model-search" placeholder="Search models" />
                    </div>
                    <CommandList id="composer-model-list" className="max-h-48 gap-1">
                        <CommandEmpty className="text-muted-foreground text-body-md py-2 text-center">
                            No model matches.
                        </CommandEmpty>
                        <CommandGroup>
                            {available.map((model) => (
                                <Row
                                    key={`${model.provider}/${model.id}`}
                                    value={`${model.provider}/${model.id}`}
                                    active={
                                        current !== null &&
                                        model.provider === current.provider &&
                                        model.id === current.id
                                    }
                                    onSelect={() => choose(model)}
                                >
                                    <span className="min-w-0 flex-1 truncate">{model.name}</span>
                                </Row>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </Panel>
        </Popover>
    );
}

/** The thinking level of the session, in the words of pi. */
function ThinkingPicker({
    session,
    current,
    open,
    onOpenChange,
}: {
    session: string;
    current: ModelThinkingLevel | null;
    open: boolean;
    onOpenChange: (panel: ComposerPanel) => void;
}) {
    const client = useQueryClient();
    const levels = useQuery({ ...sessionQueries.thinkingLevels(session), enabled: open });
    const available = levels.data?.levels ?? [];

    const choose = (level: ModelThinkingLevel) => {
        onOpenChange(null);
        if (level === current) return;
        void bridge
            .setThinkingLevel(session, level)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    };

    return (
        <Popover open={open} onOpenChange={(next) => onOpenChange(next ? "thinking" : null)}>
            <PopoverTrigger asChild>
                <PickerKey
                    id="composer-thinking"
                    label={current ?? "Thinking"}
                    ariaLabel="Choose the thinking level"
                    icon={<Brain className="size-4 shrink-0" />}
                />
            </PopoverTrigger>
            <Panel id="composer-thinking-popup" className="w-44">
                <Command className="bg-transparent p-0">
                    <CommandList id="composer-thinking-list" className="max-h-52 gap-1">
                        <CommandGroup>
                            {available.map((level) => (
                                <Row
                                    key={level}
                                    value={level}
                                    active={level === current}
                                    onSelect={() => choose(level)}
                                >
                                    <span className="min-w-0 flex-1 truncate">{level}</span>
                                </Row>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </Panel>
        </Popover>
    );
}
