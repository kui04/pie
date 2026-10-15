import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";

beforeEach(() => {
    // Frame throttle runs at once, so updates land inside `act`.
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

function mockViewport(height: number, scale = 1) {
    const listeners = new Map<string, () => void>();
    const viewport = {
        height,
        scale,
        addEventListener: vi.fn((name: string, read: () => void) => {
            listeners.set(name, read);
        }),
        removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    return { viewport, listeners };
}

describe("the keyboard inset", () => {
    it("is zero where visualViewport is absent", () => {
        Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });

        expect(renderHook(() => useKeyboardInset()).result.current).toBe(0);
    });

    it("is the gap the keyboard takes", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        const { viewport, listeners } = mockViewport(400);

        const { result } = renderHook(() => useKeyboardInset());
        expect(result.current).toBe(300);

        act(() => {
            viewport.height = 700;
            listeners.get("resize")?.();
        });
        expect(result.current).toBe(0);
    });

    it("ignores a gap below the open threshold", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        mockViewport(640);

        expect(renderHook(() => useKeyboardInset()).result.current).toBe(0);
    });

    it("ignores pinch zoom", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        mockViewport(350, 2);

        expect(renderHook(() => useKeyboardInset()).result.current).toBe(0);
    });
});
