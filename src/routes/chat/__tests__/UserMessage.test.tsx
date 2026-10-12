import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { user as userMessage } from "@/preview/fixtures";
import { UserMessage } from "@/routes/chat/transcript/entries/UserMessage";
import type { UserMessage as UserMessageData } from "@/lib/rpc-protocol";

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

const asUser = (message: ReturnType<typeof userMessage>) => message as UserMessageData;

describe("UserMessage", () => {
    it("gives every bubble the same corners, and a single line a tighter box", () => {
        const { unmount } = render(<UserMessage id="e1" message={asUser(userMessage("one line"))} />);
        const one = screen.getByText("one line").closest("[id]");
        // One radius whatever the length - the tile's - and the words decide only
        // the box.
        expect(one?.className).toContain("rounded-md");
        expect(one?.className).not.toContain("rounded-full");
        expect(one?.className).not.toContain("rounded-xl");
        expect(one?.className).toContain("py-2");
        unmount();

        render(<UserMessage id="e2" message={asUser(userMessage("one line\nand another"))} />);
        const many = screen.getByText(/and another/).closest("[id]");
        expect(many?.className).toContain("rounded-md");
        expect(many?.className).toContain("p-3");
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

    it("marks a message that waits, and offers its retract in the menu", async () => {
        const retract = vi.fn();
        render(
            <UserMessage id="q1" message={asUser(userMessage("waiting words"))} queued="steer" onRetract={retract} />,
        );

        expect(screen.getByText("queued · steer")).toBeInTheDocument();
        fireEvent.contextMenu(screen.getByText("waiting words"));
        await userEvent.click(await screen.findByText("Retract queued message"));

        expect(retract).toHaveBeenCalledTimes(1);
    });

    it("names the other queue under the bubble", () => {
        render(
            <UserMessage
                id="q2"
                message={asUser(userMessage("waiting words"))}
                queued="followUp"
                onRetract={vi.fn()}
            />,
        );

        expect(screen.getByText("queued · follow-up")).toBeInTheDocument();
    });
});
