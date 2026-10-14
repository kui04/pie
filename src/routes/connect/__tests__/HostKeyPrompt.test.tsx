/**
 * The prompt in both of its shapes, and the one thing both must never do:
 * decide anything on the person's behalf.
 *
 * Which host is drawn is pinned per test rather than left to `useIsPhone`,
 * because a viewport cannot fake pointer capability — and happy-dom answers
 * `(pointer: coarse)` with true, so an unpinned test would only ever have
 * covered the sheet.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostKeyPrompt } from "@/routes/connect/HostKeyPrompt";
import type { PresentedKey } from "@/lib/bridge";

const KEY: PresentedKey = {
    host: "192.168.1.10",
    port: 22,
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:2a:b4:c1:88:9f:0e",
};

afterEach(cleanup);

/** Both hosts, so every assertion below runs against both. */
const HOSTS = [
    ["sheet", true],
    ["dialog", false],
] as const;

describe.each(HOSTS)("the host-key prompt as a %s", (_host, isMobile) => {
    it("says what a person has to check, and what checking it means", () => {
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile={isMobile} />);

        const prompt = screen.getByRole("dialog");
        expect(prompt).toHaveTextContent("Trust this host?");
        expect(prompt).toHaveTextContent(KEY.fingerprint);
        expect(prompt).toHaveTextContent(KEY.algorithm);
        expect(prompt).toHaveTextContent("This host has never been seen.");
    });

    it("answers yes when trusted", async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={onAnswer} isMobile={isMobile} />);

        await user.click(screen.getByRole("button", { name: "Trust" }));

        expect(onAnswer).toHaveBeenCalledWith(true);
    });

    it("answers no when cancelled", async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={onAnswer} isMobile={isMobile} />);

        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onAnswer).toHaveBeenCalledWith(false);
    });

    it("treats walking away as a refusal, because Rust is still waiting", async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={onAnswer} isMobile={isMobile} />);

        await user.keyboard("{Escape}");

        // The alternative is a question Rust keeps asking for its full patience
        // with nobody left to answer it.
        expect(onAnswer).toHaveBeenCalledWith(false);
    });

    it("draws nothing at all when there is no question", () => {
        render(<HostKeyPrompt presentedKey={null} onAnswer={vi.fn()} isMobile={isMobile} />);

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("the host-key prompt's host", () => {
    it("draws the sheet on touch and the dialog otherwise", () => {
        const { unmount } = render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile />);
        // Vaul marks its own container; the sheet is the only host that does.
        expect(document.querySelector("[data-vaul-drawer]")).not.toBeNull();
        unmount();

        render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile={false} />);
        expect(document.querySelector("[data-vaul-drawer]")).toBeNull();
    });

    it("asks from the window's bottom edge, and not from its side", () => {
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile />);
        const sheet = document.querySelector("[data-vaul-drawer]");
        // Which edge the sheet arrives from is this prompt's own shape; how the
        // wrapper draws that sheet is the wrapper's business, pinned in its test.
        expect(sheet?.getAttribute("data-vaul-drawer-direction")).toBe("bottom");
        expect(sheet?.className).not.toContain("mx-auto");
    });

    it("floats its dialog, so all four of that one's corners show", () => {
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile={false} />);
        // A dialog is not the window's edge: it keeps every corner it has.
        expect(screen.getByRole("dialog").className).toContain("rounded-xl");
    });
});
