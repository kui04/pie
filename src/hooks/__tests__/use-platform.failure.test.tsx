import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { loadPlatform, useIsMobile } from "@/hooks/use-platform";

/**
 * What happens when the platform cannot be read at all.
 *
 * Its own file because the ask is cached for the life of the module: a module
 * that has already answered cannot also be one whose answer failed.
 */
const report = vi.hoisted(() => vi.fn<() => Promise<Bridge.Platform>>());

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    platform: report,
}));

describe("a platform Rust cannot answer", () => {
    it("waits rather than throwing, and says why once", async () => {
        report.mockRejectedValue(new Error("no IPC bridge here"));
        const complained = vi.spyOn(console, "error").mockImplementation(() => undefined);

        // A blank window that said why beats an error boundary over a blank one:
        // there is nothing honest to draw without knowing the platform.
        expect(await loadPlatform()).toBeNull();
        expect(complained).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledOnce();
        expect(renderHook(() => useIsMobile()).result.current).toBe(false);

        complained.mockRestore();
    });
});
