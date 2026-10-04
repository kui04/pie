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
import { HostKeyPrompt } from "@/routes/connect/components/HostKeyPrompt";
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

    it("keeps the two hosts off the window's edges and inside the 26rem cap", () => {
        render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile />);
        const sheet = document.querySelector("[data-vaul-drawer]");
        expect(sheet?.className).toContain("inset-x-4");
        expect(sheet?.className).toContain("max-w-104");
    });

    it("rounds only the sheet's top corners, because its bottom is the window's", () => {
        const { unmount } = render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile />);
        // A sheet is flush with the bottom edge; rounding there would draw a
        // gap the window does not have.
        expect(document.querySelector("[data-vaul-drawer]")?.className).toContain("rounded-t-xl");
        unmount();

        render(<HostKeyPrompt presentedKey={KEY} onAnswer={vi.fn()} isMobile={false} />);
        // A dialog floats, so all four of its corners show.
        expect(screen.getByRole("dialog").className).toContain("rounded-xl");
    });
});
