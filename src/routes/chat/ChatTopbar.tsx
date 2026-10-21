/**
 * The bar of the window: the drag region, what the stage puts in it, and the
 * window's own keys at its end.
 *
 * It is the handle of a window without decorations, so a press on it drags it
 * (`deep`: a press anywhere on the bar counts, while the buttons in it keep
 * their own clicks; see tauri's `window/scripts/drag.js`). It is the chat's first
 * row: a solid surface plane with one line of fade below it, over the transcript.
 * It has two parts: the start, where the way to the list and the conversation's
 * name stand, and the end, where the conversation's actions and the window's
 * keys stand. A phone's OS owns the frame, so the keys are a desktop's alone.
 */

import type { ReactNode } from "react";

import { WindowControls } from "@/components";
import { Separator } from "@/components/ui";
import { useIsMobile } from "@/hooks";

export function ChatTopbar({ start, end }: { start?: ReactNode; end?: ReactNode }) {
    const isMobile = useIsMobile();

    return (
        // The first row of the chat: its own surface, and the fade below it is
        // the head of the transcript's scroll area.
        <div
            id="topbar"
            data-tauri-drag-region="deep"
            className="relative z-20 flex min-h-11 w-full shrink-0 items-center gap-1 bg-surface px-3"
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
            <div id="topbar-fade" aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-full">
                <div className="mx-auto w-full max-w-5xl">
                    <div className="h-4 bg-linear-to-b from-surface to-surface/0" />
                </div>
            </div>
        </div>
    );
}
