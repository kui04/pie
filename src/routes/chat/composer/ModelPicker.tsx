/**
 * The model of the session: a pill with a popup above it.
 *
 * The change is not kept here: the session reports it as a `model_change` entry and as
 * the model of its state, and the state is read again after the call.
 *
 * The popup reads the models of the session (`get_available_models`) when it opens, and
 * the active value comes from the state of the session. The value a row shows is the
 * value of pi, verbatim.
 *
 * A host with every provider configured offers some six hundred models, which is far
 * more than the popup can show: the search reads the whole catalog, and the list draws
 * the rows it ranks first (see `MODEL_ROWS`).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command as CommandPrimitive, defaultFilter } from "cmdk";
import { Bot, Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { ScrollPane } from "@/components";
import * as bridge from "@/lib/bridge";
import type { Model } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";

export interface ModelPickerProps {
    /** The session whose model this changes. */
    session: string;
    /** The model that is active, from the state of the session. */
    current: Model | null;
    /** Whether the popup is open. The caller holds this, so one popup is open at a time. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function ModelPicker({ session, current, open, onOpenChange }: ModelPickerProps) {
    const client = useQueryClient();
    const models = useQuery({ ...sessionQueries.models(session), enabled: open });
    const catalogue = models.data?.models;
    const value = current === null ? null : choiceOf(current);

    const choose = (chosen: string) => {
        const model = catalogue?.find((candidate) => choiceOf(candidate) === chosen);
        if (model === undefined || chosen === value) return;
        void bridge
            .setModel(session, model.provider, model.id)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    };

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <Button
                    id="composer-model"
                    variant="ghost"
                    size="sm"
                    aria-label="Choose the model"
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
                    <ProviderMark provider={current?.provider ?? null} />
                    <span className="text-label-lg hidden max-w-40 truncate sm:block">{current?.name ?? "Model"}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                id="composer-model-popup"
                side="top"
                align="center"
                sideOffset={12}
                // The draft's model popup is a fixed 240px (its own max-height), so the
                // popup is the same shape whether a host offers three models or six
                // hundred.
                className={cn(
                    "elevation-raised bg-card text-foreground mx-2",
                    "flex h-60 max-h-60 w-68 flex-col gap-1 overflow-hidden p-2",
                )}
            >
                <ModelMenu
                    catalogue={catalogue ?? []}
                    value={value}
                    onChoose={(chosen) => {
                        onOpenChange(false);
                        choose(chosen);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

interface ModelMenuProps {
    /** Every model the session can use, as pi named it. */
    catalogue: readonly Model[];
    /** The model in use, by `choiceOf`, which leads the rows while nothing is typed. */
    value: string | null;
    onChoose: (choice: string) => void;
}

/**
 * The list of the popup: the search, the rows it draws, and the keyboard over them.
 *
 * A closed popup keeps nothing of it: Radix draws the content only while it is open, so
 * the list mounts with it and forgets the search it was left with.
 */
function ModelMenu({ catalogue, value, onChoose }: ModelMenuProps) {
    const [query, setQuery] = useState("");

    // What the popup draws: the whole catalog while nothing is typed, the rows the
    // search ranks first once something is, and never more than `MODEL_ROWS` of them.
    const shown = useMemo(() => {
        const search = query.trim();
        if (search === "") {
            // The model in use leads the list: the popup opens on it.
            const rest = catalogue.filter((model) => choiceOf(model) !== value);
            const inUse = catalogue.find((model) => choiceOf(model) === value);
            return (inUse === undefined ? rest : [inUse, ...rest]).slice(0, MODEL_ROWS);
        }
        return (
            catalogue
                .map((model) => ({ model, score: defaultFilter(choiceOf(model), search, [model.name]) }))
                .filter((row) => row.score > 0)
                // The sort is stable, so rows of one score keep the catalog's own order.
                .sort((left, right) => right.score - left.score)
                .slice(0, MODEL_ROWS)
                .map((row) => row.model)
        );
    }, [catalogue, query, value]);

    return (
        <CommandPrimitive
            // The rows arrive ranked and counted: the search reads the whole catalog,
            // which cmdk cannot see, because it filters what is drawn. Its own keyboard
            // keeps up with them: it takes the first row as the search changes, and the
            // arrows move it from there.
            shouldFilter={false}
            defaultValue={value ?? undefined}
            label="Choose the model"
            className="flex min-h-0 flex-1 flex-col gap-1"
        >
            <div
                className={cn(
                    "border-border-strong bg-surface-container-highest",
                    "flex items-center gap-2 rounded-lg border px-2 py-2",
                )}
            >
                <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <CommandPrimitive.Input
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search models"
                    className="text-body-md placeholder:text-outline min-w-0 flex-1 bg-transparent outline-hidden"
                />
            </div>
            <ScrollPane id="composer-model-scroll" className="min-h-0 flex-1">
                <CommandPrimitive.List className="flex min-h-0 flex-col outline-none [&>div]:flex [&>div]:flex-col [&>div]:gap-1">
                    <CommandPrimitive.Empty className="text-muted-foreground text-body-md py-2 text-center">
                        No match.
                    </CommandPrimitive.Empty>
                    {shown.map((model) => {
                        const choice = choiceOf(model);
                        const inUse = choice === value;
                        return (
                            <CommandPrimitive.Item
                                key={choice}
                                value={choice}
                                onSelect={() => onChoose(choice)}
                                className={cn(
                                    "text-muted-foreground flex cursor-default items-center gap-2",
                                    "rounded-lg px-2 py-2 outline-hidden select-none",
                                    "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                                    inUse && "bg-accent text-accent-foreground font-medium",
                                )}
                            >
                                <ProviderMark provider={model.provider} />
                                <span className="text-body-md min-w-0 flex-1 truncate">{model.name}</span>
                                {inUse && <Check className="text-primary-text size-4 shrink-0" aria-label="In use" />}
                            </CommandPrimitive.Item>
                        );
                    })}
                </CommandPrimitive.List>
            </ScrollPane>
        </CommandPrimitive>
    );
}

/**
 * How many matches the popup draws at once.
 *
 * The popup is 240px of a column, about six rows of it, while a host with every
 * provider configured offers some six hundred models: drawing all of them is a wait
 * on every open, and the same wait on every key pressed.
 */
const MODEL_ROWS = 40;

/** What a row is worth: provider and id, the way a model is named here and in pi. */
function choiceOf(model: Model) {
    return `${model.provider}/${model.id}`;
}

/**
 * How long the mark of a provider stays good on this side of the bridge, in
 * milliseconds: the day Rust keeps it too (`LOGO_TTL` of `commands/app.rs`).
 * Within it, an opened popup draws the mark without asking Rust again.
 */
const LOGO_TTL = 24 * 60 * 60 * 1000;

/** The mark of a provider from Rust, or `null` when models.dev has none. */
function useProviderLogo(provider: string | null) {
    return useQuery({
        queryKey: ["provider-logo", provider],
        // A null provider never reaches this: `enabled` is what holds the one key
        // of a picker that has no model yet.
        queryFn: () => bridge.providerLogo(provider ?? ""),
        enabled: provider !== null,
        staleTime: LOGO_TTL,
        retry: false,
    });
}

/**
 * The mark of a provider: the logo of models.dev, or the key of the composer
 * when the provider has none.
 *
 * Every mark of models.dev is one shape in `currentColor`. A mask keeps the shape
 * and lets the theme supply the ink, which an `<img>` cannot: inside an image,
 * `currentColor` is black whatever the page says.
 */
function ProviderMark({ provider }: { provider: string | null }) {
    const logo = useProviderLogo(provider);
    if (logo.data === null || logo.data === undefined) {
        return <Bot className="size-4 shrink-0" aria-hidden />;
    }
    return (
        <span
            data-provider={provider}
            aria-hidden
            className="size-4 shrink-0 bg-current"
            style={{
                maskImage: `url(${logo.data})`,
                maskPosition: "center",
                maskRepeat: "no-repeat",
                maskSize: "contain",
                WebkitMaskImage: `url(${logo.data})`,
                WebkitMaskPosition: "center",
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
            }}
        />
    );
}
