import type { ReactElement } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RouterProvider, createBrowserRouter, useLocation } from "react-router";
import { ChatScreen } from "@/routes/chat/ChatScreen";
import { ConnectScreen } from "@/routes/connect/ConnectScreen";
import { ARRIVE, HANDOVER, LEAVE, SETTLED } from "@/lib/motion";

/**
 * The places to be, by path.
 *
 * The screens are held here rather than as route elements because an exiting
 * animation has to keep rendering the screen it was showing. A wrapper around
 * `<Outlet/>` would not: the route context changes underneath it, the exiting
 * subtree re-renders, and it swaps to the arriving screen half way through its
 * own fade-out. An element chosen here is what the wrapper captured, so the
 * leaving surface stays the leaving surface until it is gone.
 *
 * An unknown path lands on the gate, which is where the window starts anyway.
 *
 * Being captured at module load is the same trade: a screen here is built once
 * and takes its props from nowhere. The day one needs them, it becomes a
 * function of the location rather than an element.
 */
const SCREENS: Record<string, ReactElement> = {
    "/": <ConnectScreen />,
    "/chat": <ChatScreen />,
};

function Workspace() {
    const { pathname } = useLocation();

    return (
        // `mode="wait"`: both surfaces are full-screen, so the leaving one has to
        // be gone before the arriving one is drawn. Without it they would be
        // painted over each other for the length of the handover.
        <AnimatePresence mode="wait" initial={false}>
            <motion.div
                key={pathname}
                initial={ARRIVE}
                animate={SETTLED}
                exit={LEAVE}
                transition={HANDOVER}
                className="flex min-h-0 flex-1 flex-col"
            >
                {SCREENS[pathname] ?? SCREENS["/"]}
            </motion.div>
        </AnimatePresence>
    );
}

const router = createBrowserRouter([{ path: "*", element: <Workspace /> }]);

export function AppRoutes() {
    return <RouterProvider router={router} />;
}
