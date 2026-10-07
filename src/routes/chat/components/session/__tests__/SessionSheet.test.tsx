import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionSheet } from "@/routes/chat/components/session/SessionSheet";

/** A window that answers one query, and can be told to change its answer. */
function windowThatMatches() {
    const listeners: Array<() => void> = [];
    let matches = false;
    const list = {
        get matches() {
            return matches;
        },
        media: "(min-width: 64rem)",
        addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: () => undefined,
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(list);
    return {
        listeners,
        becomeWide: () => {
            matches = true;
            for (const listener of listeners) listener();
        },
    };
}

describe("SessionSheet", () => {
    it("lets go when the window reaches the width of the column", async () => {
        const window_ = windowThatMatches();
        const closed = vi.fn();

        render(
            <SessionSheet id="session-sheet" open onOpenChange={closed}>
                <p>the list</p>
            </SessionSheet>,
        );
        // A sheet that is closed costs nothing: nothing is asked of the host.
        expect(closed).not.toHaveBeenCalled();

        window_.becomeWide();

        // A modal holds the page itself (the body is `pointer-events: none` while it
        // is open), so a sheet that the CSS hides would leave the workspace unable to
        // be touched. This is what closes it instead. The width is read through a
        // store, so the re-render it causes is what the wait is for.
        await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
        vi.restoreAllMocks();
    });
});
