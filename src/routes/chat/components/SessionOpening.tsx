import { motion } from "motion/react";
import { Spinner } from "@/components/ui/spinner";
import { STAGE, STAGE_ARRIVE, STAGE_SETTLED } from "@/lib/motion";

/**
 * What the body says while a conversation is on its way: a ring and a word.
 *
 * The wait is a wait for words, and the ring says it is a wait and not a stall.
 * The layer under it is whatever the reader was looking at - the landing they
 * picked from, or the conversation that is being left - and it goes quiet as this
 * one arrives (`Session`), so the window changes its stage and not its frame.
 */
export function SessionOpening() {
    return (
        <motion.div
            id="session-opening"
            initial={STAGE_ARRIVE}
            animate={STAGE_SETTLED}
            exit={STAGE_ARRIVE}
            transition={STAGE}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3"
        >
            <Spinner className="text-muted-foreground size-5" />
            <p className="text-body-md text-muted-foreground">Opening the session…</p>
        </motion.div>
    );
}
