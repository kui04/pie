import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { log } from "@/lib/bridge";
import { queryClient } from "@/lib/query";
import "./index.css";

/**
 * A failure no code caught has no other way out: the webview's console is not a
 * place anybody reads. The browser's own "ResizeObserver loop" note is not a
 * failure - it says a notification was folded into the next delivery, which the
 * transcript's measuring list does while it scrolls - so it goes to debug.
 */
(() => {
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
})();

/** The same way out for a promise nobody caught, and the same reason to take it. */
(() => {
    window.addEventListener("unhandledrejection", (event) => {
        log.error("a promise was rejected with nobody to catch it", { reason: String(event.reason) });
    });
})();

/**
 * The bar of the region that is moving shows itself; how it looks is `index.css`'s business.
 *
 * `scroll` does not bubble, so the capture phase is the one listener that hears every
 * region - and each event's own target is the region that moved, which is the element this
 * marks. Marking the document instead would light up the bar of every region in the app for
 * a scroll in one of them.
 */
(() => {
    /** The class a moving region wears, and how long it keeps it after its last move. */
    const REVEALED = "is-scrolling";
    const HOLD_MS = 700;

    /** The region holding the mark. */
    let shown: Element | null = null;
    let hold: ReturnType<typeof setTimeout> | undefined;

    document.addEventListener(
        "scroll",
        (event) => {
            const region = event.target;
            if (!(region instanceof Element)) return;
            if (region !== shown) {
                shown?.classList.remove(REVEALED);
                shown = region;
                region.classList.add(REVEALED);
            }
            clearTimeout(hold);
            hold = setTimeout(() => {
                shown?.classList.remove(REVEALED);
                shown = null;
            }, HOLD_MS);
        },
        { capture: true, passive: true },
    );
})();

// The reader's own answer about motion, once, so that a report about what moves - or about
// something that does not - can be read against it.
log.info("the reader's motion", {
    reduce: typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});

/**
 * Visual viewport metrics written directly to root CSS variables (--vv-height,
 * --vv-offset-top, --kb-inset).
 *
 * Keeps layout and keyboard insets in sync with the compositor across frames
 * without routing high-frequency viewport animations through React.
 */
(() => {
    const root = document.documentElement;
    const KEYBOARD_THRESHOLD = 80;

    const computeKeyboardInset = (offsetTop: number, height: number, scale: number): number => {
        if (scale !== 1) return 0;
        const innerHeight = window.innerHeight;
        const inset = innerHeight - (offsetTop + height);
        if (!Number.isFinite(inset) || inset < KEYBOARD_THRESHOLD) return 0;
        return Math.round(inset);
    };

    let frame = 0;
    const write = () => {
        frame = 0;
        const innerHeight = window.innerHeight;
        const viewport = window.visualViewport;

        if (viewport === null || viewport === undefined) {
            root.style.setProperty("--vv-height", `${innerHeight}px`);
            root.style.setProperty("--vv-offset-top", "0px");
            root.style.setProperty("--kb-inset", "0px");
            root.removeAttribute("data-keyboard-open");
            return;
        }

        const top = Math.round(viewport.offsetTop ?? 0);
        const height = Math.round(viewport.height);
        const scale = viewport.scale ?? 1;
        const inset = computeKeyboardInset(top, height, scale);

        root.style.setProperty("--vv-height", `${height}px`);
        root.style.setProperty("--vv-offset-top", `${top}px`);
        root.style.setProperty("--kb-inset", `${inset}px`);
        if (inset > 0) {
            root.setAttribute("data-keyboard-open", "true");
        } else {
            root.removeAttribute("data-keyboard-open");
        }
    };

    const schedule = () => {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(write);
    };

    write();

    const viewport = window.visualViewport;
    if (viewport !== null && viewport !== undefined) {
        viewport.addEventListener("resize", schedule);
        viewport.addEventListener("scroll", schedule);
    }
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
        </QueryClientProvider>
    </React.StrictMode>,
);
