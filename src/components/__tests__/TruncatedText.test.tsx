import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TruncatedText } from "../TruncatedText";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("TruncatedText", () => {
    it("keeps the card away while the text fits", () => {
        render(
            <TruncatedText content="The full name" delay={0} closeDelay={0}>
                The full name
            </TruncatedText>,
        );

        expect(screen.queryByText("The full name")).toHaveAttribute("data-slot", "truncated-text");
        expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull();
    });

    it("shows the full value when the trigger is clipped", async () => {
        vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(240);
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);

        render(
            <TruncatedText content="A name the row cannot show" delay={0} closeDelay={0}>
                A name…
            </TruncatedText>,
        );

        const trigger = screen.getByText("A name…");
        fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
        fireEvent.mouseEnter(trigger);

        await waitFor(() => {
            expect(screen.getByText("A name the row cannot show")).toBeInTheDocument();
        });

        const card = document.querySelector(String.raw`[data-slot="hover-card-content"]`);
        expect(card).toHaveClass("w-max");
    });

    it("takes the card's placement, line clamp, and text alignment", () => {
        render(
            <TruncatedText
                content="Two lines of words"
                lines={2}
                side="right"
                align="center"
                textAlign="end"
                data-testid="trigger"
            >
                Two lines of words
            </TruncatedText>,
        );

        const trigger = screen.getByTestId("trigger");
        expect(trigger).toHaveClass("line-clamp-2", "text-end");
    });
});
