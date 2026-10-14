import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { useIsMobile } from "@/hooks/use-platform";

/**
 * The platform is a fact about the machine rather than a measurement of the window: asked
 * once, as this module loads, never guessed, never moving afterwards.
 *
 * What is deliberately absent: a test that a suspended component wakes up. React 19's `use()`
 * never retries when its promise settles under this repository's test environment - confirmed
 * with a two-line component and none of this code involved - so such a test would fail for
 * reasons unconnected to it. The wake-up was checked in a real browser instead; what is
 * checked here is the part this module owns.
 *
 * The module asks as it is imported, so the mock answers from the start - and how often it was
 * asked is counted here rather than read off the mock, whose own log the runner clears before
 * every test, this call having been made before the first of them.
 */
const platform = vi.hoisted(() => {
    let made = 0;
    const answer = vi.fn<() => Promise<Bridge.Platform>>(() => {
        made += 1;
        return Promise.resolve("mobile");
    });
    return { answer, made: () => made };
});

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    platform: platform.answer,
}));

/** The ask settles in a microtask, which no test can watch settle. */
const answered = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the platform Rust reports", () => {
    it("is whatever Rust says", async () => {
        await answered();

        expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    });

    it("is asked once, however many readers there are", async () => {
        await answered();
        renderHook(() => useIsMobile());
        renderHook(() => useIsMobile());

        // The answer cannot change while the app runs, so a second round trip would be a
        // question with only one possible reply.
        expect(platform.made()).toBe(1);
    });

    it("reads without suspending, so a preview needs no backend", () => {
        // What a story sees: an answer already in hand, and no hang.
        expect(() => renderHook(() => useIsMobile())).not.toThrow();
    });
});
