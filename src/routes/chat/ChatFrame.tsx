/**
 * The window of the chat: the list's column where it holds one, and the page
 * beside it.
 *
 * The chat draws the window itself, so this is where the chat's own shape is
 * said: two regions, edge to edge, told apart by the one hairline the column
 * carries; and a column of two on the chat's side — the bar, and the body under
 * it. The bar is the handle of a window without decorations, so a press on it
 * drags it (`deep`: a press anywhere on the bar counts, while the buttons in it
 * keep their own clicks; see tauri's `window/scripts/drag.js`), and the window's
 * own keys end it. The page keeps the system bars' room as a whole (`SafeArea`), and
 * a phone's OS owns the frame, so the keys are a desktop's alone.
 */

import type { ReactNode } from "react";
import { cn } from "cn";
import { SafeArea, WindowControls } from "@/components";
import { useIsMobile } from "@/hooks/use-platform";

export function ChatFrame({
    sidebar,
    topbar,
    bodyClassName,
    children,
}: {
    sidebar?: ReactNode;
    topbar?: ReactNode;
    bodyClassName?: string;
    children?: ReactNode;
}) {
    const isMobile = useIsMobile();

    return (
        <main id="window" className="bg-surface text-foreground flex min-h-0 w-full flex-1 overflow-hidden font-sans">
            <SafeArea side="all" id="safe-main" className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                {sidebar}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <div
                        id="topbar"
                        data-tauri-drag-region="deep"
                        className="flex min-h-11 shrink-0 items-center gap-1 px-3"
                    >
                        {topbar}
                        {!isMobile && <WindowControls />}
                    </div>
                    <div id="transcript" className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", bodyClassName)}>
                        {children}
                    </div>
                </div>
            </SafeArea>
        </main>
    );
}
