import { AnimatePresence, motion } from "motion/react";
import { useMotion } from "@/hooks/use-motion";

export interface CardBodyProps {
    /** Whether the card is open. */
    open: boolean;
    /** The id a trigger points at with `aria-controls`. */
    id?: string;
    children: React.ReactNode;
}

/**
 * The part of a card that opens and closes.
 *
 * It is there when the card is open, and its own height is what moves. While the
 * card is closed it does not exist at all, so a closed card holds no text for a
 * search to find or a thumb to reach.
 */
export function CardBody({ open, id, children }: CardBodyProps) {
    const { reveal } = useMotion();

    return (
        <AnimatePresence initial={false}>
            {open && (
                <motion.div id={id} className="overflow-hidden" {...reveal}>
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
