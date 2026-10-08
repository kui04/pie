import type { ReactNode } from "react";
import { cn } from "cn";
import { WindowControls } from "@/components/WindowControls";
import { useIsMobile } from "@/hooks/use-platform";

/**
 * The window: the session list in a column of its own, and the chat beside it.
 *
 * Two regions, edge to edge, told apart by the one hairline the column carries.
 * The chat is a column of two: the bar, and the body under it — the transcript,
 * or the gate's card.
 *
 * The bar is the window's own handle. The window has no decorations, so a press
 * on the bar drags it (`deep`: a press anywhere on the bar counts, while the
 * buttons in it keep their own clicks; see tauri's `window/scripts/drag.js`).
 * A phone's OS owns the frame there, so it shows no keys and nothing to drag.
 */
export interface WindowProps {
    /** The session list, where the window holds one. */
    sidebar?: ReactNode;
    /** What the bar carries before the window's keys: the session's own slots. */
    topbar?: ReactNode;
    /** The body under the bar. */
    children?: ReactNode;
    /** The body's own classes, where a screen centres what it draws. */
    bodyClassName?: string;
}

export function Window({ sidebar, topbar, children, bodyClassName }: WindowProps) {
    const isMobile = useIsMobile();

    return (
        <main id="window" className="text-foreground flex min-h-0 w-full flex-1 overflow-hidden font-sans">
            {sidebar}
            <div id="chat" className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {/* A bar with nothing in it is not drawn: a phone's gate has no
                    keys, and no slots either. */}
                {(topbar !== undefined || !isMobile) && (
                    <div
                        id="topbar"
                        data-tauri-drag-region={isMobile ? undefined : "deep"}
                        // No colour of its own and no hairline under it: the bar is
                        // part of the chat's plane, which starts at the window's top
                        // edge (the chat's own background shows through).
                        className="flex h-11 shrink-0 items-center gap-1 px-3"
                    >
                        {topbar}
                        {!isMobile && <WindowControls />}
                    </div>
                )}
                <div id="transcript" className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", bodyClassName)}>
                    {children}
                </div>
            </div>
        </main>
    );
}
