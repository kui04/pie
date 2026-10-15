import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { useIsMobile } from "@/hooks/usePlatform";

/**
 * What happens when the platform cannot be read at all.
 *
 * Its own file because the ask is made for the life of the module: a module that has already
 * answered cannot also be one whose answer failed. The mock fails from the start, before the
 * module's own ask, and the complaint the module makes on the way past is heard from the start
 * too - counted here rather than read off the spy, whose log the runner clears before every
 * test, this call having been made before the first of them.
 */
const platform = vi.hoisted(() => {
    let made = 0;
    const answer = vi.fn<() => Promise<Bridge.Platform>>(() => {
        made += 1;
        return Promise.reject(new Error("no IPC bridge here"));
    });
    return { answer, made: () => made };
});

const complained = vi.hoisted(() => {
    let said = 0;
    const heard = vi.spyOn(console, "error").mockImplementation(() => {
        said += 1;
    });
    return { heard, said: () => said };
});

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    platform: platform.answer,
}));

/** The ask settles in a microtask, which no test can watch settle. */
const answered = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a platform Rust cannot answer", () => {
    it("waits rather than throwing, and says why once", async () => {
        // A blank window that said why beats an error boundary over a blank one: there is
        // nothing honest to draw without knowing the platform.
        await answered();

        expect(platform.made()).toBe(1);
        expect(complained.said()).toBe(1);
        expect(renderHook(() => useIsMobile()).result.current).toBe(false);

        complained.heard.mockRestore();
    });
});
