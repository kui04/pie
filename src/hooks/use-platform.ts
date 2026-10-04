/**
 * Which kind of machine pie is on, as Rust reports it.
 *
 * A fact rather than a measurement, so it is asked once and kept: a binary cannot
 * change the OS it was built for, and neither a resize nor a pointer changes the
 * answer. A media query would answer a different question — how wide this window
 * is — and get a phone-shaped desktop window and a landscape tablet wrong.
 *
 * Module state rather than a context because there is one value and no provider
 * to thread through the router.
 */

import { use, useSyncExternalStore } from "react";
import type { Platform } from "@/lib/bridge";
import * as bridge from "@/lib/bridge";

let answered: Platform | null = null;
let asking: Promise<Platform | null> | null = null;
const readers = new Set<() => void>();

function subscribe(read: () => void): () => void {
    readers.add(read);
    return () => {
        readers.delete(read);
    };
}

/**
 * Asks once and never rejects.
 *
 * A failure resolves to `null` and says why on the way past, so the shell can
 * wait on this without an error boundary around it and a blank window is still
 * explainable.
 */
function ask(): Promise<Platform | null> {
    asking ??= bridge
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
    return asking;
}

/**
 * Starts the round trip, early.
 *
 * Called before React mounts: the answer is a hop to Rust, and the boundary
 * below should have something to show by the time it is asked rather than a
 * blank frame the reader watches arrive.
 */
export function loadPlatform(): Promise<Platform | null> {
    return ask();
}

/**
 * The platform, suspending until Rust has answered.
 *
 * Separate from {@link useIsMobile} because suspending is only legal below a
 * boundary: with no `Suspense` above it React throws instead of falling back,
 * and a story renders its subject at the root. A story is not left waiting,
 * though — {@link ask} settles on failure too, just as `null`.
 */
export function usePlatformResource(): Platform | null {
    return use(ask());
}

/**
 * Whether this is a phone or tablet: a machine with no window manager.
 *
 * Reads rather than suspends, so a component can ask inside a preview. False
 * until Rust has answered, which in the app is never: the shell above waits
 * first.
 */
export function useIsMobile(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => answered === "mobile",
        () => false,
    );
}
