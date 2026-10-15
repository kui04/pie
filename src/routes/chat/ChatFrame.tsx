/**
 * The window of the chat: the list's column where it holds one, and the page
 * beside it.
 *
 * The chat draws the window itself, so this is where the chat's own shape is
 * said: two regions, edge to edge, told apart by the one hairline the column
 * carries; and a column of two — the bar, and the body under it, both drawn by
 * the stage that fills this frame. The page keeps the system bars' room as a
 * whole (`SafeArea`), and a phone's OS owns the frame, so the window's own keys
 * are a desktop's alone.
 *
 * The frame stands still across the window's stages: the list, and the column
 * that holds it, belong to the workspace rather than to the conversation in
 * view, so a pick does not rebuild them.
 */

import type { ReactNode } from "react";

import { SafeArea } from "@/components";

export function ChatFrame({ sidebar, children }: { sidebar?: ReactNode; children?: ReactNode }) {
    return (
        <main id="window" className="bg-surface text-foreground flex min-h-0 w-full flex-1 overflow-hidden font-sans">
            <SafeArea side="all" id="safe-main" className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                {sidebar}
                <div id="session-column" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    {children}
                </div>
            </SafeArea>
        </main>
    );
}
