import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowSize } from "@/hooks/useWindowSize";

afterEach(() => {
    Reflect.deleteProperty(window, "innerWidth");
    Reflect.deleteProperty(window, "innerHeight");
});

describe("the window size", () => {
    it("tracks the layout viewport and keeps a stable snapshot", () => {
        Object.defineProperty(window, "innerWidth", { value: 320, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });

        const { result } = renderHook(() => useWindowSize());
        expect(result.current).toEqual({ windowHeight: 700, windowWidth: 320 });
        const still = result.current;

        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(result.current).toBe(still);

        Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(result.current).toEqual({ windowHeight: 844, windowWidth: 390 });
    });
});
