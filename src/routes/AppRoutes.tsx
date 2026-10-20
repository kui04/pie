import type { ReactElement } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useConnectionWatch, useMotion } from "@/hooks";
import { ConnectionLostOverlay } from "@/routes/connect/ConnectionLostOverlay";
import { RouterProvider, createBrowserRouter, useLocation } from "react-router";
import { ChatScreen } from "@/routes/chat/ChatScreen";
import { ConnectScreen } from "@/routes/connect/ConnectScreen";

const SCREENS: Record<string, ReactElement> = {
    "/": <ConnectScreen />,
    "/chat": <ChatScreen />,
};

function Screen() {
    const { pathname } = useLocation();
    const { stage } = useMotion();
    // The connection is watched here, above the pages: a lost connection is not a page's
    // business, and the overlay stands over whichever page is up. The overlay is a dialog, so
    // it draws in a portal and the page below it stays where it was.
    const watch = useConnectionWatch();

    return (
        <>
            <AnimatePresence mode="wait" initial={false}>
                <motion.div key={pathname} {...stage} className="flex min-h-0 flex-1 flex-col">
                    {SCREENS[pathname] ?? SCREENS["/"]}
                </motion.div>
            </AnimatePresence>
            <ConnectionLostOverlay
                state={watch.state}
                endpoint={watch.endpoint}
                message={watch.message}
                onRetry={watch.retry}
                onLeave={watch.leave}
            />
        </>
    );
}

const router = createBrowserRouter([{ path: "*", element: <Screen /> }]);

export function AppRoutes() {
    return <RouterProvider router={router} />;
}
