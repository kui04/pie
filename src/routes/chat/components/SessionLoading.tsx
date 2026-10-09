import { motion } from "motion/react";
import { Spinner } from "@/components/ui/spinner";
import { STAGE, STAGE_ARRIVE, STAGE_SETTLED } from "@/lib/motion";

/**
 * The page of the window that says a conversation is coming: a ring and a word.
 *
 * The wait is a wait for words, and the ring says it is a wait and not a stall.
 * Nothing of the conversation being left stands under it - a switch gives those
 * words up when it is taken - so this page is the whole of what the reader sees,
 * and it leaves as the words of the answer arrive (`Session`).
 */
export function SessionLoading() {
    return (
        <motion.div
            id="session-loading"
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
