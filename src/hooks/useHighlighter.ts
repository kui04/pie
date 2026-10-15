import { useEffect, useSyncExternalStore } from "react";
import { loadedHighlighter, loadHighlighter, subscribeToHighlighter } from "@/lib/code-highlight";

/** The syntax highlighter, once its chunk has landed; null while it has not. */
export function useHighlighter() {
    const highlighter = useSyncExternalStore(subscribeToHighlighter, loadedHighlighter, loadedHighlighter);

    // Asked for after the first paint, so nothing waits on a chunk that only a code block
    // needs - and only ever once, whatever draws a block first.
    useEffect(() => {
        void loadHighlighter();
    }, []);

    return highlighter;
}
