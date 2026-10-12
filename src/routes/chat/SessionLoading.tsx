import { motion } from "motion/react";
import { Spinner } from "@/components/ui";

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
