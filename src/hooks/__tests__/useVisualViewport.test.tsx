import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewport } from "@/hooks/useVisualViewport";

beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => {
        run(0);
        return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function mockViewport(height: number, width = 400, offsetLeft = 0, offsetTop = 0, scale = 1) {
    const listeners = new Map<string, () => void>();
    const viewport = {
        height,
        width,
        scale,
        offsetLeft,
        offsetTop,
        addEventListener: vi.fn((name: string, read: () => void) => {
            listeners.set(name, read);
        }),
        removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    return { viewport, listeners };
}

describe("the visual viewport", () => {
    it("falls back to the layout size where visualViewport is absent", () => {
        Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });

        expect(renderHook(() => useVisualViewport()).result.current).toEqual({
            offsetLeft: 0,
            offsetTop: 0,
            height: 700,
            width: 400,
            scale: 1,
        });
    });

    it("tracks the whole rectangle and keeps a stable snapshot", () => {
        const { viewport, listeners } = mockViewport(400, 390, 20, 120, 2);

        const { result } = renderHook(() => useVisualViewport());
        expect(result.current).toEqual({
            offsetLeft: 20,
            offsetTop: 120,
            height: 400,
            width: 390,
            scale: 2,
        });
        const still = result.current;

        act(() => {
            listeners.get("resize")?.();
        });
        expect(result.current).toBe(still);

        act(() => {
            viewport.offsetLeft = 0;
            viewport.offsetTop = 0;
            viewport.height = 600;
            viewport.width = 400;
            viewport.scale = 1;
            listeners.get("scroll")?.();
        });
        expect(result.current).toEqual({
            offsetLeft: 0,
            offsetTop: 0,
            height: 600,
            width: 400,
            scale: 1,
        });
    });
});
