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
 * A host with every provider configured offers some six hundred models, so the popup draws
 * every one of them, ordered as pi orders them, and searches them by pi's own matching
 * (`lib/fuzzy.ts`): a model that typing finds in pi is found by typing the same here.
 */

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { Bot, Check, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from "@/components/ui";
import { ScrollPane } from "@/components";
import * as bridge from "@/lib/bridge";
import { fuzzyFilter } from "@/lib/fuzzy";
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
    const mark = useProviderLogo(current?.provider ?? null);
    const catalogue = models.data?.models;
    const value = current === null ? null : choiceOf(current);

    const choose = useCallback(
        (chosen: string) => {
            const model = catalogue?.find((candidate) => choiceOf(candidate) === chosen);
            if (model === undefined || chosen === value) return;
            void bridge
                .setModel(session, model.provider, model.id)
                .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
                .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
        },
        // The rows hold this, and a fresh one would redraw all of them.
        [catalogue, client, session, value],
    );

    const pick = useCallback(
        (chosen: string) => {
            onOpenChange(false);
            choose(chosen);
        },
        [choose, onOpenChange],
    );

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger
                render={
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
                    />
                }
            >
                <ProviderMark provider={current?.provider ?? null} mark={mark.data ?? null} />
                <span className="text-label-lg hidden max-w-40 truncate sm:block">{current?.name ?? "Model"}</span>
            </PopoverTrigger>
            <PopoverContent
                id="composer-model-popup"
                side="top"
                align="center"
                sideOffset={12}
                // The draft's model popup is a fixed 240px (its own max-height), so the
                // popup is the same shape whether a host offers three models or six
                // hundred. The cap follows the visible viewport, so an open
                // keyboard cannot push it off screen.
                className={cn(
                    "elevation-raised bg-card text-foreground mx-2",
                    "flex h-60 max-h-[min(15rem,calc(100dvh-12rem))] w-68 flex-col gap-1 overflow-hidden p-2",
                )}
            >
                <ModelMenu
                    catalogue={catalogue ?? []}
                    state={models.isPending ? "loading" : models.isError ? "failed" : "ready"}
                    value={value}
                    onChoose={pick}
                />
            </PopoverContent>
        </Popover>
    );
}

interface ModelMenuProps {
    /** Every model the session can use, as pi named it. */
    catalogue: readonly Model[];
    /** Where the catalog is: on its way, here, or not to be had. */
    state: "loading" | "failed" | "ready";
    /** The model in use, by `choiceOf`, which leads the rows while nothing is typed. */
    value: string | null;
    onChoose: (choice: string) => void;
}

/**
 * The list of the popup: the search, the rows it draws, and the cursor over them.
 *
 * The rows are pi's own shape and not a list widget's: pi's terminal selector keeps one
 * cursor and draws every row itself. The shape matters at this size - the same catalog
 * through a list widget took 150ms to open on a desktop, and a cap on the drawn rows was
 * what hid the rest of it instead.
 *
 * A closed popup keeps nothing of it: Radix draws the content only while it is open, so
 * the list mounts with it and forgets what was typed in it.
 */
function ModelMenu({ catalogue, state, value, onChoose }: ModelMenuProps) {
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState<number | null>(null);
    const [hovered, setHovered] = useState<number | null>(null);
    const marks = useProviderMarks(catalogue);
    const list = useRef<VirtualizerHandle>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const listId = `${useId()}-models`;

    // What the popup draws: the whole catalog, ordered by provider while nothing is
    // typed and ranked by pi's own matching once something is.
    const shown = useMemo(() => {
        const search = query.trim();
        return search === "" ? orderedByProvider(catalogue, value) : searchModels(catalogue, search);
    }, [catalogue, query, value]);

    // The row the keyboard stands on, once a key has moved it: nothing is lit before that,
    // and a row of the catalog is not lit for being the model in use - its check says so.
    const at = cursor ?? -1;
    // What is lit: the row under the pointer while there is one, the keyboard's row when it
    // is not, and neither once the pointer has left a list nothing has moved in.
    const lit = shown.length === 0 ? -1 : Math.min(hovered ?? at, shown.length - 1);
    const move = (step: number) => {
        if (shown.length === 0) return;
        // A key takes the light from the pointer, and stands where the keyboard left it -
        // the first row down, the last one up.
        setHovered(null);
        setCursor((current) => {
            if (current === null) return step > 0 ? 0 : shown.length - 1;
            return (current + step + shown.length) % shown.length;
        });
    };

    // The cursor is brought into view by the list itself: six hundred rows are not drawn, so
    // a row to scroll to is a position and not an element. The pointer does not scroll the
    // list: a row it is over is already under it.
    useLayoutEffect(() => {
        if (at < 0 || shown.length === 0) return;
        list.current?.scrollToIndex(Math.min(at, shown.length - 1), { align: "nearest" });
    }, [at, query, shown.length]);

    // A catalog that could not be read is not a search that found nothing: the popup says
    // what happened instead of offering a list of nothing, and there is nothing to search.
    if (state === "failed") {
        return <p className="text-muted-foreground text-body-md px-2 py-4 text-center">Could not read the models.</p>;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div
                className={cn(
                    "border-border-strong bg-surface-container-highest",
                    "flex items-center gap-2 rounded-lg border p-2",
                )}
            >
                <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <input
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={lit < 0 ? undefined : `${listId}-${lit}`}
                    aria-autocomplete="list"
                    aria-label="Search models"
                    // The search is what a model is found by, so the popup opens on it.
                    autoFocus
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        // The best match of the new search, as pi's selector lights it.
                        setCursor(0);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            move(1);
                        } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            move(-1);
                        } else if (event.key === "Enter") {
                            // With nothing lit, the key keeps the model in use.
                            const picked =
                                lit < 0
                                    ? value === null
                                        ? shown[0]
                                        : catalogue.find((model) => choiceOf(model) === value)
                                    : shown[lit];
                            if (picked !== undefined) {
                                event.preventDefault();
                                onChoose(choiceOf(picked));
                            }
                        }
                    }}
                    placeholder="Search models"
                    type="search"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
                    className="text-body-md placeholder:text-outline min-w-0 flex-1 bg-transparent outline-hidden"
                />
            </div>
            <ScrollPane id="composer-model-scroll" viewportRef={viewport} className="min-h-0 flex-1">
                {state === "loading" ? (
                    <ModelSkeleton />
                ) : (
                    <div
                        role="listbox"
                        id={listId}
                        aria-label="Models"
                        // The pointer leaving takes its light with it.
                        onMouseLeave={() => setHovered(null)}
                        className="outline-none"
                    >
                        {shown.length === 0 && (
                            <p className="text-muted-foreground text-body-md py-2 text-center">No match.</p>
                        )}
                        <Virtualizer
                            ref={list}
                            data={shown}
                            itemSize={ROW}
                            // The rows past the window are drawn ahead of it, which is what
                            // keeps a fast scroll from arriving before them.
                            bufferSize={AHEAD}
                            scrollRef={viewport}
                        >
                            {(model, index) => (
                                <div key={choiceOf(model)} className="pb-1">
                                    <ModelRow
                                        id={`${listId}-${index}`}
                                        model={model}
                                        mark={marks.get(model.provider) ?? null}
                                        at={index}
                                        inUse={choiceOf(model) === value}
                                        lit={index === lit}
                                        onPoint={setHovered}
                                        onChoose={onChoose}
                                    />
                                </div>
                            )}
                        </Virtualizer>
                    </div>
                )}
            </ScrollPane>
        </div>
    );
}

interface ModelRowProps {
    id: string;
    model: Model;
    /** The mark of this row's provider. */
    mark: string | null;
    /** Where the row sits in the list, which is what the pointer reports. */
    at: number;
    /** Whether this is the model in use. */
    inUse: boolean;
    /** Whether this row is lit: the pointer is on it, or the cursor stands on it. */
    lit: boolean;
    onPoint: (at: number) => void;
    onChoose: (choice: string) => void;
}

/**
 * One row. It is drawn again only when it changes: the props of a row that stays in the list
 * are the same objects and numbers on every keystroke, so typing does not redraw six hundred
 * rows - the light moving between two of them redraws two.
 *
 * Every row reads in the plane's own ink, and only its light changes: `aria-selected` is the
 * row Enter would take, which is the lit row - the pointer's while the pointer is in the
 * list, the keyboard's when it is not. The model in use is marked by its check and by
 * nothing else.
 */
const ModelRow = memo(function ModelRow({ id, model, mark, at, inUse, lit, onPoint, onChoose }: ModelRowProps) {
    const choice = choiceOf(model);
    return (
        <div
            id={id}
            role="option"
            aria-selected={lit}
            data-lit={lit}
            onClick={() => onChoose(choice)}
            onMouseMove={() => onPoint(at)}
            className={cn(
                "text-foreground flex cursor-default items-center gap-2",
                "h-9 rounded-lg px-2 select-none",
                "data-[lit=true]:bg-accent",
            )}
        >
            <ProviderMark provider={model.provider} mark={mark} />
            <span className="text-body-md min-w-0 flex-1 truncate">{model.name}</span>
            {inUse && <Check className="text-primary-text size-4 shrink-0" aria-label="In use" />}
        </div>
    );
});

/**
 * The rows of the popup before the catalog arrives: the layout a row takes, drawn as bars, so
 * the popup opens at the height it keeps and does not move when the models land. Five of them
 * fill it, each with the mark of a provider and a name, and a row of a reader who asked for
 * less motion stands still.
 */
function ModelSkeleton() {
    return (
        <div role="status" aria-label="Loading the models" className="flex flex-col gap-1">
            {WIDTHS.map((width, row) => (
                <div key={row} aria-hidden className="flex items-center gap-2 rounded-lg p-2">
                    <Skeleton className="size-4 shrink-0 motion-reduce:animate-none" />
                    <Skeleton className={cn("h-5", width, "motion-reduce:animate-none")} />
                </div>
            ))}
        </div>
    );
}

/** The width of each name bar, so the rows do not read as one bar repeated. */
const WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-1/3", "w-4/5"];

/**
 * The height of one row with the air under it: a line of `text-body-md` in 8px of padding is
 * the row, and the list keeps 4px between rows. The skeleton rows are the same size.
 */
const ROW = 40;

/**
 * How much of the list beyond the popup is drawn, in pixels: virtua's `bufferSize`, which its
 * own note raises "to avoid showing blank items in fast [scrolling]". A row is 40px, so this
 * stands in for twenty rows either side of the window.
 */
const AHEAD = 800;

/**
 * The rows while nothing is typed: the model in use first, then by provider, as pi's own
 * selector lists them. pi also lifts its saved default model second, which pie has no
 * notion of - the default of a session is what pi was started with.
 */
function orderedByProvider(catalogue: readonly Model[], value: string | null): readonly Model[] {
    const rest = catalogue
        .filter((model) => choiceOf(model) !== value)
        .sort((left, right) => left.provider.localeCompare(right.provider));
    const inUse = catalogue.find((model) => choiceOf(model) === value);
    return inUse === undefined ? rest : [inUse, ...rest];
}

/** What a row is worth: provider and id, the way a model is named here and in pi. */
function choiceOf(model: Model) {
    return `${model.provider}/${model.id}`;
}

/**
 * The text a query is matched against, as pi's own `/model` selector builds it
 * (`packages/coding-agent/src/modes/interactive/model-search.ts` of the pinned release).
 *
 * The provider leads, and the bare id does not: a query naming a provider must find the
 * provider's own model before a proxy's, whose id spells the same model out
 * (`openrouter/openai/gpt-5` against `openai/gpt-5`).
 */
function getModelSearchText(model: Model): string {
    const { id, provider } = model;
    const name = model.name ? ` ${model.name}` : "";
    return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/** The models the query finds, best first, by pi's matching and pi's ranking. */
function searchModels(models: readonly Model[], query: string): readonly Model[] {
    return fuzzyFilter(models, query, (model) => getModelSearchText(model));
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
 * The marks of every provider of the catalog, asked for once for the whole list.
 *
 * One question per provider and not one per row: a row that asked for its own mark would
 * put a subscription into each of six hundred rows, and opening the popup would wait on all
 * of them.
 */
function useProviderMarks(catalogue: readonly Model[]): ReadonlyMap<string, string | null> {
    const providers = useMemo(() => [...new Set(catalogue.map((model) => model.provider))], [catalogue]);
    const marks = useQueries({
        queries: providers.map((provider) => ({
            queryKey: ["provider-logo", provider],
            queryFn: () => bridge.providerLogo(provider),
            staleTime: LOGO_TTL,
            retry: false,
        })),
    });
    return useMemo(
        () => new Map(providers.map((provider, index) => [provider, marks[index]?.data ?? null])),
        [marks, providers],
    );
}

/**
 * The mark of a provider: the logo of models.dev, or the key of the composer
 * when the provider has none.
 *
 * Every mark of models.dev is one shape in `currentColor`. A mask keeps the shape
 * and lets the theme supply the ink, which an `<img>` cannot: inside an image,
 * `currentColor` is black whatever the page says.
 */
function ProviderMark({ provider, mark }: { provider: string | null; mark: string | null }) {
    if (mark === null) {
        return <Bot className="size-4 shrink-0" aria-hidden />;
    }
    return (
        <span
            data-provider={provider}
            aria-hidden
            className="size-4 shrink-0 bg-current"
            style={{
                maskImage: `url(${mark})`,
                maskPosition: "center",
                maskRepeat: "no-repeat",
                maskSize: "contain",
                WebkitMaskImage: `url(${mark})`,
                WebkitMaskPosition: "center",
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
            }}
        />
    );
}
