import { LoaderCircle } from "lucide-react";
import { motion } from "motion/react";
import { Hourglass, Icon } from "@/components";
import { Marker } from "@/components/ui";
import { useMotion } from "@/hooks/useMotion";

/** What a run is doing while the app waits on it (`lib/stream.ts`). */
export type ActivityState = "waiting" | "working";

export interface RunLineProps {
    state: ActivityState;
}

/**
 * The line under the transcript while a run goes on.
 *
 * It wears the same body as a row of work: a 24px slot at the block's left edge, filled with the
 * plane the transcript is drawn on, and its word at the column every other word stands in - so
 * the line under the list belongs to the column it reports on, whether or not a fold stands
 * above it.
 *
 * `Waiting…` is the gap between what a reader sent and the model's first output: over a network
 * the round trip is long enough to name, so it gets the hourglass that every other wait in the
 * transcript carries. `Working…` begins with the model's first output and stays until the run is
 * over, which covers the call that runs under it.
 */
export function RunLine({ state }: RunLineProps) {
    return (
        <Marker id="run-line" className="min-h-10 sm:min-h-[34px]">
            <Icon className="relative z-10 justify-start bg-surface" aria-hidden>
                <Mark state={state} />
            </Icon>
            <span className="text-body-md trim">{state === "waiting" ? "Waiting…" : "Working…"}</span>
        </Marker>
    );
}

/** The mark of a state: the hourglass of a wait, the turning ring of work. */
function Mark({ state }: { state: ActivityState }) {
    const { turn } = useMotion();

    if (state === "waiting") {
        return (
            <span className="flex shrink-0">
                <Hourglass label="Waiting" />
            </span>
        );
    }
    return (
        <motion.span className="flex shrink-0 text-primary-text" {...turn}>
            <LoaderCircle aria-label="Working" />
        </motion.span>
    );
}
