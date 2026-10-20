/**
 * The bar of the window: the drag region, what the stage puts in it, and the
 * window's own keys at its end.
 *
 * It is the handle of a window without decorations, so a press on it drags it
 * (`deep`: a press anywhere on the bar counts, while the buttons in it keep
 * their own clicks; see tauri's `window/scripts/drag.js`). It has two parts: the
 * start, where the way to the list and the conversation's name stand, and the
 * end, where the conversation's actions and the window's keys stand. A phone's
 * OS owns the frame, so the keys are a desktop's alone.
 */

import type { ReactNode } from "react";

import { WindowControls } from "@/components";
import { Separator } from "@/components/ui";
import { useIsMobile } from "@/hooks/usePlatform";

export function ChatTopbar({ start, end }: { start?: ReactNode; end?: ReactNode }) {
    const isMobile = useIsMobile();

    return (
        // Floats transparent over the transcript's top fade: no plane, no
        // shadow, no hairline. The fade behind it keeps the words readable.
        <div
            id="topbar"
            data-tauri-drag-region="deep"
            className="absolute inset-x-0 top-0 z-20 flex min-h-11 items-center gap-1 px-3"
        >
            <div id="topbar-start" className="flex min-w-0 flex-1 items-center gap-1">
                {start}
            </div>
            <div id="topbar-end" className="flex min-w-0 shrink-0 items-center gap-1">
                {end}
                {end !== undefined && !isMobile && (
                    <Separator
                        orientation="vertical"
                        className="mx-1 h-4 self-center bg-divider data-vertical:self-center"
                    />
                )}
                {!isMobile && <WindowControls />}
            </div>
        </div>
    );
}
