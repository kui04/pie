import type { ReactElement } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RouterProvider, createBrowserRouter, useLocation } from "react-router";
import { ChatScreen } from "@/routes/chat/ChatScreen";
import { ConnectScreen } from "@/routes/connect/ConnectScreen";

const SCREENS: Record<string, ReactElement> = {
    "/": <ConnectScreen />,
    "/chat": <ChatScreen />,
};

function Screen() {
    const { pathname } = useLocation();

    return (
        <AnimatePresence mode="wait" initial={false}>
            <motion.div
                key={pathname}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: "tween", duration: 0.15 }}
                className="flex min-h-0 flex-1 flex-col"
            >
                {SCREENS[pathname] ?? SCREENS["/"]}
            </motion.div>
        </AnimatePresence>
    );
}

const router = createBrowserRouter([{ path: "*", element: <Screen /> }]);

export function AppRoutes() {
    return <RouterProvider router={router} />;
}
