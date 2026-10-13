import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { log } from "@/lib/bridge";
import { loadPlatform } from "@/hooks/use-platform";
import { queryClient } from "@/lib/query";
import "./index.css";

// A failure no code caught has no other way out: the webview's console is not a
// place anybody reads. The browser's own "ResizeObserver loop" note is not a
// failure - it says a notification was folded into the next delivery, which the
// transcript's measuring list does while it scrolls - so it goes to debug.
const RESIZE_NOTE = /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/;

window.addEventListener("error", (event) => {
    if (RESIZE_NOTE.test(event.message)) {
        event.preventDefault();
        log.debug("a resize notification was skipped", { message: event.message });
        return;
    }

    log.error("an error reached the window", {
        message: event.message,
        at: `${event.filename}:${event.lineno}:${event.colno}`,
    });
});

window.addEventListener("unhandledrejection", (event) => {
    log.error("a promise was rejected with nobody to catch it", { reason: String(event.reason) });
});

// When the scroll bar shows itself; how it looks is `index.css`'s business. `scroll`
// does not bubble, so the capture phase is the one listener that hears every region.
const REVEALED = "is-scrolling";
const HOLD_MS = 700;
let hold: ReturnType<typeof setTimeout> | undefined;

document.addEventListener(
    "scroll",
    () => {
        document.documentElement.classList.add(REVEALED);
        clearTimeout(hold);
        hold = setTimeout(() => document.documentElement.classList.remove(REVEALED), HOLD_MS);
    },
    { capture: true, passive: true },
);

// Asked for before the first render, so no screen draws on an unknown platform.
void loadPlatform();

// The reader's own answer about motion, once, so that a report about what moves - or about
// something that does not - can be read against it.
log.info("the reader's motion", {
    reduce: typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
        </QueryClientProvider>
    </React.StrictMode>,
);
