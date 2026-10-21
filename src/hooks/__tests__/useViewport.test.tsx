import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewport, useWideWindow } from "@/hooks/useViewport";

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

function mockViewport(height: number, scale = 1, offsetTop = 0) {
    const listeners = new Map<string, () => void>();
    const viewport = {
        height,
        scale,
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
    it("is closed where visualViewport is absent", () => {
        Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });

        expect(renderHook(() => useVisualViewport()).result.current).toEqual({ inset: 0, offsetTop: 0 });
    });

    it("reports the gap the keyboard takes, and keeps a stable snapshot", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        const { viewport, listeners } = mockViewport(400);

        const { result } = renderHook(() => useVisualViewport());
        expect(result.current.inset).toBe(300);
        expect(result.current.offsetTop).toBe(0);
        const still = result.current;

        act(() => {
            listeners.get("resize")?.();
        });
        expect(result.current).toBe(still);

        act(() => {
            viewport.height = 700;
            listeners.get("resize")?.();
        });
        expect(result.current.inset).toBe(0);
    });

    it("reports where the visual viewport starts", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        const { viewport, listeners } = mockViewport(400, 1, 120);

        const { result } = renderHook(() => useVisualViewport());
        expect(result.current.offsetTop).toBe(120);

        act(() => {
            viewport.offsetTop = 0;
            listeners.get("scroll")?.();
        });
        expect(result.current.offsetTop).toBe(0);
    });

    it("ignores a gap below the open threshold", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        mockViewport(640);

        expect(renderHook(() => useVisualViewport()).result.current.inset).toBe(0);
    });

    it("ignores pinch zoom", () => {
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
        mockViewport(350, 2);

        expect(renderHook(() => useVisualViewport()).result.current.inset).toBe(0);
    });
});

describe("the width of the window", () => {
    it("follows the media query for the permanent session column", () => {
        const listeners = new Set<() => void>();
        let matches = false;
        const query = {
            get matches() {
                return matches;
            },
            addEventListener: (_name: string, read: () => void) => listeners.add(read),
            removeEventListener: (_name: string, read: () => void) => listeners.delete(read),
        } as unknown as MediaQueryList;
        vi.spyOn(window, "matchMedia").mockReturnValue(query);

        const { result } = renderHook(() => useWideWindow());
        expect(result.current).toBe(false);

        matches = true;
        act(() => {
            for (const read of listeners) read();
        });
        expect(result.current).toBe(true);
    });
});
