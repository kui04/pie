import { Suspense } from "react";
import { motion } from "motion/react";
import { AppRoutes } from "@/routes/AppRoutes";
import { Toaster } from "@/components/ui";
import { useMotion, usePlatformResource, useSessionSync } from "@/hooks";

function App() {
    return (
        <Suspense fallback={null}>
            <AppShell />
        </Suspense>
    );
}

function AppShell() {
    const platform = usePlatformResource();
    const { shell } = useMotion();
    // The charts of the sessions follow the connection, not a screen: they live here, beside
    // the routes, so a run continues while another conversation is in view.
    useSessionSync();

    // TODO: Handle the case where the platform is null (e.g., show an error message or a fallback UI)
    if (platform === null) return null;

    return (
        <motion.div
            id="app-root"
            {...shell}
            className="fixed inset-0 flex flex-col overflow-hidden font-sans"
            style={{ top: "var(--vv-offset-top, 0px)" }}
        >
            <AppRoutes />
            <Toaster position="top-center" mobileOffset={{ top: "calc(1rem + env(safe-area-inset-top))" }} />
        </motion.div>
    );
}

export default App;
