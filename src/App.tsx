import { Suspense } from "react";
import { motion } from "motion/react";
import { AppRoutes } from "@/routes/AppRoutes";
import { Toaster } from "@/components/ui";
import { useMotion, usePlatformResource, useSessionSync, useVisualViewport } from "@/hooks";

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
    // A focused field can pan the visual viewport on Android. The layout keeps its size; the
    // shell only follows the panned origin so the page under the finger keeps its place.
    const { offsetTop } = useVisualViewport();
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
            style={{ top: offsetTop }}
        >
            <AppRoutes />
            <Toaster position="top-center" mobileOffset={{ top: "calc(1rem + env(safe-area-inset-top))" }} />
        </motion.div>
    );
}

export default App;
