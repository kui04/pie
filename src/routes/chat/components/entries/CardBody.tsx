import { AnimatePresence, motion, type Transition } from "motion/react";
import { REVEAL_HIDDEN, REVEAL_SHOWN } from "@/lib/motion";

export interface CardBodyProps {
    /** Whether the card is open. */
    open: boolean;
    /** The id a trigger points at with `aria-controls`. */
    id?: string;
    /** How the height moves, which depends on the machine's motion setting. */
    transition: Transition;
    children: React.ReactNode;
}

/**
 * The part of a card that opens and closes.
 *
 * It is there when the card is open, and its own height is what moves. While the
 * card is closed it does not exist at all, so a closed card holds no text for a
 * search to find or a thumb to reach.
 */
export function CardBody({ open, id, transition, children }: CardBodyProps) {
    return (
        <AnimatePresence initial={false}>
            {open && (
                <motion.div
                    id={id}
                    className="overflow-hidden"
                    initial={REVEAL_HIDDEN}
                    animate={REVEAL_SHOWN}
                    exit={REVEAL_HIDDEN}
                    transition={transition}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
