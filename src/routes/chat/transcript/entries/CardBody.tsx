import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMotion } from "@/hooks/use-motion";

export interface CardBodyProps {
    /** Whether the card is open. */
    open: boolean;
    /** The id a trigger points at with `aria-controls`. */
    id?: string;
    children: ReactNode;
}

/**
 * The part of a card that opens and closes.
 *
 * It is there when the card is open, and its own height is what moves - while it opens, and
 * not while the words inside it arrive: a body whose height is animated afresh for every line
 * a run streams in lags the text it holds, and the foot of the list drifts away from the end
 * the follow holds it at.
 *
 * While the card is closed it does not exist at all, so a closed card holds no text for a
 * search to find or a thumb to reach.
 */
export function CardBody({ open, id, children }: CardBodyProps) {
    return <AnimatePresence initial={false}>{open && <OpenBody id={id}>{children}</OpenBody>}</AnimatePresence>;
}

/** A body while it is open: it reveals itself once, and then its words are its height. */
function OpenBody({ id, children }: { id?: string; children: ReactNode }) {
    const { reveal } = useMotion();
    // Fresh for every opening, because this mounts with the body and goes with it.
    const [opened, setOpened] = useState(false);

    return (
        <motion.div
            id={id}
            className="overflow-hidden"
            {...reveal}
            animate={opened ? { height: "auto", opacity: 1, transition: { duration: 0 } } : reveal.animate}
            onAnimationComplete={() => setOpened(true)}
        >
            {children}
        </motion.div>
    );
}
