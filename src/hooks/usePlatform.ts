/**
 * Which kind of machine pie is on, as Rust reports it.
 *
 * A fact rather than a measurement, so it is asked once and kept: a binary cannot
 * change the OS it was built for, and neither a resize nor a pointer changes the
 * answer. A media query would answer a different question — how wide this window
 * is — and get a phone-shaped desktop window and a landscape tablet wrong.
 *
 * Module state rather than a context because there is one value and no provider to thread
 * through the router.
 */

import { use, useEffect, useSyncExternalStore } from "react";
import type { Platform } from "@/lib/bridge";
import * as bridge from "@/lib/bridge";

let answered: Platform | null = null;
const readers = new Set<() => void>();

/**
 * The round trip, asked for the first time a hook needs it and kept for the run.
 *
 * The shell asks through {@link usePlatformResource} before its first render, so it has an
 * answer in hand rather than a blank frame the reader watches arrive.
 *
 * It never rejects: a failure resolves to `null` and says why on the way past, so the shell
 * can wait on it without an error boundary around it, and a blank window is still
 * explainable.
 */
let asked: Promise<Platform | null> | null = null;

function askPlatform(): Promise<Platform | null> {
    asked ??= bridge
        .platform()
        .then((platform) => {
            answered = platform;
            for (const read of readers) read();
            return platform;
        })
        .catch((thrown: unknown) => {
            console.error("pie could not read its own platform; is this running outside Tauri?", thrown);
            return null;
        });
    return asked;
}

function subscribe(read: () => void): () => void {
    readers.add(read);
    return () => {
        readers.delete(read);
    };
}

/**
 * The platform, suspending until Rust has answered.
 *
 * Separate from {@link useIsMobile} because suspending is only legal below a
 * boundary: with no `Suspense` above it React throws instead of falling back,
 * and a story renders its subject at the root. A story is not left waiting,
 * though — {@link asked} settles on failure too, just as `null`.
 */
export function usePlatformResource(): Platform | null {
    return use(askPlatform());
}

/**
 * Whether this is a phone or tablet: a machine with no window manager.
 *
 * Reads rather than suspends, so a component can ask inside a preview. False
 * until Rust has answered, which in the app is never: the shell above waits
 * first.
 */
export function useIsMobile(): boolean {
    useEffect(() => {
        void askPlatform();
    }, []);
    return useSyncExternalStore(
        subscribe,
        () => answered === "mobile",
        () => false,
    );
}
