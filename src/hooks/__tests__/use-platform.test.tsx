import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { loadPlatform, useIsMobile } from "@/hooks/use-platform";

/**
 * The platform is a fact about the machine rather than a measurement of the
 * window: asked once, never guessed, never moving afterwards.
 *
 * What is deliberately absent: a test that a suspended component wakes up. React
 * 19's `use()` never retries when its promise settles under this repository's
 * test environment — confirmed with a two-line component and none of this code
 * involved — so such a test would fail for reasons unconnected to it. The
 * wake-up was checked in a real browser instead; what is checked here is the
 * part this module owns.
 *
 * These run in order against one module instance, because the module holds the
 * answer for the life of the app and that lifetime is the behaviour under test.
 * A module whose ask fails is a different one, in `use-platform.failure.test.tsx`.
 */
const report = vi.hoisted(() => vi.fn<() => Promise<Bridge.Platform>>());

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    platform: report,
}));

describe("the platform Rust reports", () => {
    beforeEach(() => {
        report.mockReset();
    });

    it("is whatever Rust says", async () => {
        report.mockResolvedValue("mobile");

        expect(await loadPlatform()).toBe("mobile");
        expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    });

    it("is asked once, however many callers there are", async () => {
        // The first test already asked, and `beforeEach` cleared the count, so
        // what matters here is that asking again adds nothing.
        const asked = report.mock.calls.length;

        await Promise.all([loadPlatform(), loadPlatform()]);
        await loadPlatform();

        // The answer cannot change while the app runs, so a second round trip
        // would be a question with only one possible reply.
        expect(report).toHaveBeenCalledTimes(asked);
    });

    it("never moves once it has", async () => {
        const asked = report.mock.calls.length;
        report.mockResolvedValue("desktop");
        await loadPlatform();

        expect(renderHook(() => useIsMobile()).result.current).toBe(true);
        expect(report).toHaveBeenCalledTimes(asked);
    });

    it("reads without suspending, so a preview needs no backend", () => {
        // What a story sees: an answer already in hand, and no hang.
        expect(() => renderHook(() => useIsMobile())).not.toThrow();
    });
});
