import { Suspense } from "react";
import { motion } from "motion/react";
import { AppRoutes } from "@/routes/AppRoutes";
import { Toaster } from "@/components/ui";
import { usePlatformResource } from "@/hooks/use-platform";
import { SWAP } from "@/lib/motion";

function App() {
    // Nothing below draws until Rust has said what machine this is, so no window
    // or overlay ever has to guess a shape and take it back.
    return (
        <Suspense fallback={null}>
            <Shell />
        </Suspense>
    );
}

function Shell() {
    const platform = usePlatformResource();

    // Only reachable when the read failed, which has already said why.
    if (platform === null) return null;

    return (
        <motion.div
            id="app-root"
            // Arriving rather than snapping in: the platform read is a hop to
            // Rust, and without this the first frame after it is a hard cut.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={SWAP}
            // `h-svh` and not `min-h-svh`: a minimum does not constrain, so the shell would
            // grow to fit a long form and the document would scroll — taking the
            // window's own bar out of a window that has no decorations of its own to
            // drag.
            // `pl-safe`/`pr-safe` are room the island or the navigation bar takes
            // in landscape; both are zero in portrait and on a desktop.
            className="pl-safe pr-safe flex h-svh w-full flex-col overflow-hidden font-sans"
        >
            <AppRoutes />
            {/* The one toast stack the window owns, over every page: the toast
                component has no corner of its own, so the host places it. A phone
                draws its status bar over the window, so the stack keeps its own gap
                and adds the bar's room; sonner's own mobile gap is 1rem.

                The colours are the design's, not the registry's `popover` default:
                the registry's `Toaster` spreads a call site's `style` over its own,
                which is the one seam these three have. */}
            <Toaster
                position="top-center"
                mobileOffset={{ top: "calc(1rem + env(safe-area-inset-top))" }}
                style={
                    {
                        "--normal-bg": "var(--surface-container-highest)",
                        "--normal-text": "var(--foreground)",
                        "--border-radius": "0.375rem",
                    } as React.CSSProperties
                }
            />
        </motion.div>
    );
}

export default App;
