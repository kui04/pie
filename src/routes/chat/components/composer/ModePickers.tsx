/**
 * The two settings of a session that the composer can change: its model and its
 * thinking level.
 *
 * Each one is a pill with a popup above it (`SelectWithSearch`), and the draft gives the
 * two popups their shape: the model list is long enough to be searched and is pinned to
 * the height the draft caps it at, while the four levels of thinking are a plain list of
 * four rows, 11rem wide. Both are centred on their pill and are the only two states the
 * caller holds.
 *
 * The two popups read the models and the levels of the session (`get_available_models`,
 * `get_available_thinking_levels`) when they open; the active values come from the state
 * of the session, which the change reports back through `get_state`. The value a row
 * shows is the value of pi, verbatim.
 *
 * One popup is open at a time: the caller holds which one, so a click on the other pill
 * closes the first and opens the second.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Brain } from "lucide-react";
import { toast } from "sonner";
import { SelectWithSearch } from "@/components";
import * as bridge from "@/lib/bridge";
import type { Model, ModelThinkingLevel } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";

/** Which popup of the composer is open, if any. */
export type ComposerPanel = "model" | "thinking" | null;

export interface ModePickersProps {
    /** The session whose model and thinking level these change. */
    session: string;
    /** The model that is active, from the state of the session. */
    model: Model | null;
    /** The thinking level that is active, from the state of the session. */
    thinking: ModelThinkingLevel | null;
    /** The popup that is open, if any. */
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

/**
 * The model of the session.
 *
 * The change is not kept here: the session reports it as a `model_change` entry and as
 * the model of its state, and the state is read again after the call.
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
    const value = current === null ? null : `${current.provider}/${current.id}`;

    const choose = (chosen: string) => {
        const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === chosen);
        if (model === undefined || chosen === value) return;
        void bridge
            .setModel(session, model.provider, model.id)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    };

    return (
        <SelectWithSearch
            id="composer-model"
            ariaLabel="Choose the model"
            label={current?.name ?? "Model"}
            icon={<Bot className="size-4 shrink-0" />}
            value={value}
            choices={available.map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.name,
                // What pi calls the model: the value the row is worth already carries the
                // provider and the id, so the name is what the search needs told.
                keywords: [model.name],
            }))}
            onChoose={choose}
            open={open}
            onOpenChange={(next) => onOpenChange(next ? "model" : null)}
            search="Search models"
            // The draft's model popup is a fixed 240px (its own max-height), so the popup
            // is the same shape whether a host offers three models or thirty.
            className="h-60 w-[17rem]"
        />
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
        <SelectWithSearch
            id="composer-thinking"
            ariaLabel="Choose the thinking level"
            label={current ?? "Thinking"}
            icon={<Brain className="size-4 shrink-0" />}
            value={value}
            choices={available.map((level) => ({ value: level, label: level }))}
            onChoose={choose}
            open={open}
            onOpenChange={(next) => onOpenChange(next ? "thinking" : null)}
            className="w-44"
        />
    );
}
