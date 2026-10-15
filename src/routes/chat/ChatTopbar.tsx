/**
 * The bar of the window: the drag region, what the stage puts in it, and the
 * window's own keys at its end.
 *
 * It is the handle of a window without decorations, so a press on it drags it
 * (`deep`: a press anywhere on the bar counts, while the buttons in it keep
 * their own clicks; see tauri's `window/scripts/drag.js`). Each stage draws its
 * own: the landing offers the way to the list, and a session offers what it is
 * called and how full its context is. A phone's OS owns the frame, so the keys
 * are a desktop's alone.
 */

import type { ReactNode } from "react";

import { WindowControls } from "@/components";
import { useIsMobile } from "@/hooks/usePlatform";

export function ChatTopbar({ children }: { children?: ReactNode }) {
    const isMobile = useIsMobile();

    return (
        // Floats transparent over the transcript's top fade: no plane, no
        // shadow, no hairline. The fade behind it keeps the words readable.
        <div
            id="topbar"
            data-tauri-drag-region="deep"
            className="absolute inset-x-0 top-0 z-20 flex min-h-11 items-center gap-1 px-3"
        >
            {children}
            {!isMobile && <WindowControls />}
        </div>
    );
}
