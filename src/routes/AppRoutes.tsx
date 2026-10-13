import type { ReactElement } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMotion } from "@/hooks/use-motion";
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

    return (
        <AnimatePresence mode="wait" initial={false}>
            <motion.div key={pathname} {...stage} className="flex min-h-0 flex-1 flex-col">
                {SCREENS[pathname] ?? SCREENS["/"]}
            </motion.div>
        </AnimatePresence>
    );
}

const router = createBrowserRouter([{ path: "*", element: <Screen /> }]);

export function AppRoutes() {
    return <RouterProvider router={router} />;
}
