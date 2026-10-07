import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { user as userMessage } from "@/preview/fixtures";
import { UserMessage } from "@/routes/chat/components/entries/UserMessage";
import type { UserMessage as UserMessageData } from "@/lib/protocol";

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

const asUser = (message: ReturnType<typeof userMessage>) => message as UserMessageData;

describe("UserMessage", () => {
    it("draws one line as a pill and several as a card", () => {
        const { unmount } = render(<UserMessage id="e1" message={asUser(userMessage("one line"))} />);
        // The shape is the design's: a one-line question reads as a pill, and a
        // longer one has no line to be a pill around.
        expect(screen.getByText("one line").closest("[id]")?.className).toContain("rounded-full");
        unmount();

        render(<UserMessage id="e2" message={asUser(userMessage("one line\nand another"))} />);
        expect(screen.getByText(/and another/).closest("[id]")?.className).toContain("rounded-xl");
    });

    it("copies what the reader asked, through the menu of the bubble", async () => {
        render(<UserMessage id="e1" message={asUser(userMessage("copy me"))} />);

        fireEvent.contextMenu(screen.getByText("copy me"));
        await userEvent.click(await screen.findByText("Copy"));

        expect(writeText).toHaveBeenCalledWith("copy me");
    });

    it("shows an image a request carried", () => {
        const message = asUser({
            role: "user",
            content: [
                { type: "text", text: "look at this" },
                { type: "image", data: "aGk=", mimeType: "image/png" },
            ],
            timestamp: 0,
        });

        render(<UserMessage id="e1" message={message} />);

        expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,aGk=");
        expect(screen.getByText("look at this")).toBeInTheDocument();
    });

    it("offers no menu for a request that is only an image", () => {
        const message = asUser({
            role: "user",
            content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
            timestamp: 0,
        });

        render(<UserMessage id="e1" message={message} />);

        // There is nothing to copy, so the bubble carries no menu at all.
        fireEvent.contextMenu(screen.getByRole("img"));
        expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    });
});
