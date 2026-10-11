import { motion } from "motion/react";
import { Spinner } from "@/components/ui";

/**
 * The page of the window that says a session is coming: a ring and a word.
 *
 * The wait is a wait for words, and the ring says it is a wait and not a stall.
 * Nothing of the conversation being left stands under it - a switch gives those
 * words up when it is taken - so this page is the whole of what the reader sees,
 * and it leaves as the words of the answer arrive (`Session`).
 *
 * The word is the caller's, because two waits reach this page: a conversation is
 * being opened, and the pi that will hold it is being started.
 */
export function SessionLoading({ label = "Opening the session…" }: { label?: string }) {
    return (
        <motion.div
            id="session-loading"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ type: "tween", duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3"
        >
            <Spinner className="text-muted-foreground size-5" />
            <p className="text-body-md text-muted-foreground">{label}</p>
        </motion.div>
    );
}
