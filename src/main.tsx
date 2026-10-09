import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { log } from "@/lib/bridge";
import { loadPlatform } from "@/hooks/use-platform";
import { queryClient } from "@/lib/query";
import { watchScrollbars } from "@/lib/scrollbars";
import "./index.css";

// A failure no code caught reaches a console nobody opens - and on Android there
// is no console at all. These two are the only place the window itself can report
// one, so they are the last chance for it to reach the log.
window.addEventListener("error", (event) => {
    log.error("an error reached the window", {
        message: event.message,
        at: `${event.filename}:${event.lineno}:${event.colno}`,
    });
});

window.addEventListener("unhandledrejection", (event) => {
    log.error("a promise was rejected with nobody to catch it", { reason: String(event.reason) });
});

// Before React mounts, so the shell's boundary has an answer by the time it
// asks rather than showing a blank frame and then arriving.
void loadPlatform();

watchScrollbars();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
        </QueryClientProvider>
    </React.StrictMode>,
);
