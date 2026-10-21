import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVirtualKeyboardInset } from "@/hooks/useVirtualKeyboardInset";

beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => {
        run(0);
        return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "virtualKeyboard");
});

function mockViewport(height: number, scale = 1) {
    const viewport = {
        height,
        scale,
        offsetLeft: 0,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    return viewport;
}

function mockKeyboard(rect: { x: number; y: number; width: number; height: number }, overlaysContent = true) {
    const listeners = new Map<string, () => void>();
    const keyboard = {
        overlaysContent,
        boundingRect: rect,
        addEventListener: vi.fn((name: string, read: () => void) => {
            listeners.set(name, read);
        }),
        removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "virtualKeyboard", { value: keyboard, configurable: true });
    return {
        keyboard,
        rect,
        geometryChanged: () => listeners.get("geometrychange")?.(),
    };
}

describe("the virtual keyboard inset", () => {
    it("is zero where neither keyboard API is available", () => {
        Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });

        expect(renderHook(() => useVirtualKeyboardInset()).result.current).toEqual({
            insetTop: 0,
            insetRight: 0,
            insetBottom: 0,
            insetLeft: 0,
            insetWidth: 0,
            insetHeight: 0,
        });
    });

    it("uses the VirtualKeyboard rectangle when the API exists", () => {
        const { rect, geometryChanged } = mockKeyboard({ x: 0, y: 400, width: 400, height: 300 });

        const { result } = renderHook(() => useVirtualKeyboardInset());
        expect(result.current).toEqual({
            insetTop: 400,
            insetRight: 0,
            insetBottom: 0,
            insetLeft: 0,
            insetWidth: 400,
            insetHeight: 300,
        });

        act(() => {
            rect.y = 500;
            rect.height = 200;
            geometryChanged();
        });
        expect(result.current.insetTop).toBe(500);
        expect(result.current.insetHeight).toBe(200);
    });

    it("ignores the VirtualKeyboard rectangle when the keyboard does not overlay content", () => {
        mockKeyboard({ x: 0, y: 400, width: 400, height: 300 }, false);
        mockViewport(400);

        expect(renderHook(() => useVirtualKeyboardInset()).result.current.insetHeight).toBe(300);
    });

    it("falls back to the visual viewport and keeps a stable snapshot", () => {
        mockViewport(400);

        const { result } = renderHook(() => useVirtualKeyboardInset());
        expect(result.current).toEqual({
            insetTop: 400,
            insetRight: 0,
            insetBottom: 0,
            insetLeft: 0,
            insetWidth: 400,
            insetHeight: 300,
        });
        const still = result.current;

        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(result.current).toBe(still);
    });

    it("ignores a gap below the open threshold", () => {
        mockViewport(640);

        expect(renderHook(() => useVirtualKeyboardInset()).result.current.insetHeight).toBe(0);
    });

    it("ignores pinch zoom", () => {
        mockViewport(350, 2);

        expect(renderHook(() => useVirtualKeyboardInset()).result.current.insetHeight).toBe(0);
    });
});
