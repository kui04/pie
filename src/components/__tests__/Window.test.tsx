import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "@/components/Window";

/**
 * The window *is* the layout, so the layout is what these pin: the list's column,
 * the chat beside it, and the bar over the chat with the session's slots before
 * the window's own keys. The bar is also the handle of a window without
 * decorations, and a phone's OS owns the frame there.
 */

const platform = vi.hoisted(() => ({ mobile: false }));

vi.mock("@/hooks/use-platform", () => ({
    useIsMobile: () => platform.mobile,
}));

afterEach(() => {
    platform.mobile = false;
    cleanup();
});

function show({ topbar, children }: { topbar?: ReactNode; children?: ReactNode } = {}) {
    return render(
        <Window topbar={topbar} bodyClassName="items-center justify-center">
            {children}
        </Window>,
    );
}

describe("Window", () => {
    it("stands the chat beside the list, and the body under the bar", () => {
        const { container } = show({
            topbar: <span id="session_name">Fix the parser</span>,
            children: <p>the transcript</p>,
        });

        const window_ = container.querySelector("#window");
        const chat = container.querySelector("#chat");
        const bar = container.querySelector("#topbar");
        const body = container.querySelector("#transcript");

        expect(window_).not.toBeNull();
        expect(chat).not.toBeNull();
        expect(bar).not.toBeNull();
        expect(body).not.toBeNull();
        // The bar and the body are the chat's two rows; the body takes the rest.
        expect([...(chat?.children ?? [])]).toEqual([bar, body]);
        expect(body?.className).toContain("flex-1");
    });

    it("keeps the session's slots before the window's own keys", () => {
        const { container } = show({ topbar: <span id="sidebar_toggle" /> });

        const ids = [...(container.querySelector("#topbar")?.children ?? [])].map((child) => child.id);
        expect(ids).toEqual(["sidebar_toggle", "window_controllers"]);
    });

    it("gives the bar a body of its own classes, for a screen that centres what it draws", () => {
        const { container } = show({ children: <p>the gate</p> });

        expect(container.querySelector("#transcript")?.className).toContain("items-center");
    });

    it("makes the bar the handle of a window that has no decorations", () => {
        const { container } = show();

        // `deep`: a press anywhere on the bar drags the window, while the keys in
        // it keep their own clicks (see tauri's `window/scripts/drag.js`).
        expect(container.querySelector("#topbar")?.getAttribute("data-tauri-drag-region")).toBe("deep");
    });

    it("draws no window's keys on a phone, and no empty bar either", () => {
        platform.mobile = true;

        const { container } = show();
        expect(container.querySelector("#window_controllers")).toBeNull();
        // Nothing in the bar and no OS frame to drag: the gate has no bar at all.
        expect(container.querySelector("#topbar")).toBeNull();

        cleanup();
        const withSlots = show({ topbar: <span id="session_name">Fix the parser</span> });
        expect(withSlots.container.querySelector("#topbar")).not.toBeNull();
        expect(withSlots.container.querySelector("#window_controllers")).toBeNull();
    });
});
