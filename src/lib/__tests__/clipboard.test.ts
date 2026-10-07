import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";

const writeText = vi.fn<(text: string) => Promise<void>>();
const original = navigator.clipboard;

beforeEach(() => {
    writeText.mockReset();
});

afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
});

describe("copying text", () => {
    it("answers true when the text lands", async () => {
        writeText.mockResolvedValue();
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

        await expect(copyText("hello")).resolves.toBe(true);
    });

    it("answers false when the clipboard refuses", async () => {
        writeText.mockRejectedValue(new Error("denied"));
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

        await expect(copyText("hello")).resolves.toBe(false);
    });

    it("answers false where there is no clipboard at all", async () => {
        // Some webviews have none, and there `writeText` is not a rejection but a
        // throw on the spot: the caller must still get an answer, not an exception.
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

        await expect(copyText("hello")).resolves.toBe(false);
    });

    it("answers false when the call itself throws on the spot", async () => {
        const throwing = {
            writeText: () => {
                throw new Error("SecurityError");
            },
        };
        Object.defineProperty(navigator, "clipboard", { value: throwing, configurable: true });

        await expect(copyText("hello")).resolves.toBe(false);
    });
});
