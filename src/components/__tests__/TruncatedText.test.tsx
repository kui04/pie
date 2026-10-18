/**
 * TruncatedText tests: measures overflow, displays a tooltip bubble with an arrow
 * only when text is clipped, and stays silent when text fits within bounds.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TruncatedText } from "@/components/TruncatedText";

afterEach(cleanup);

describe("TruncatedText", () => {
    it("renders the text content inside a truncated element", () => {
        render(<TruncatedText>Short text</TruncatedText>);
        const element = screen.getByText("Short text");
        expect(element).toBeInTheDocument();
        expect(element.className).toContain("truncate");
    });

    it("does not open a tooltip on hover when text is not truncated", async () => {
        render(<TruncatedText>Fitting text</TruncatedText>);
        const element = screen.getByText("Fitting text");

        // HappyDOM defaults: scrollWidth === clientWidth === 0
        await act(async () => {
            fireEvent.pointerEnter(element, { pointerType: "mouse" });
            fireEvent.mouseEnter(element);
        });

        expect(document.querySelector(".overflow-clip")).toBeNull();
    });

    it("automatically opens when text overflows scrollWidth > clientWidth", async () => {
        render(
            <TruncatedText fullText="/long/path/detected" delay={0}>
                Detected text
            </TruncatedText>,
        );
        const element = screen.getByText("Detected text");

        // Mock overflow
        Object.defineProperty(element, "scrollWidth", { configurable: true, value: 300 });
        Object.defineProperty(element, "clientWidth", { configurable: true, value: 100 });

        await act(async () => {
            fireEvent.pointerEnter(element, { pointerType: "mouse" });
            fireEvent.mouseEnter(element);
        });

        const popup = await screen.findByText("/long/path/detected");
        expect(popup).toBeInTheDocument();
    });

    it("opens a tooltip displaying full text when forced or truncated", async () => {
        render(
            <TruncatedText force fullText="/very/long/expanded/path/to/project" delay={0}>
                project
            </TruncatedText>,
        );

        const element = screen.getByText("project");

        await act(async () => {
            fireEvent.pointerEnter(element, { pointerType: "mouse" });
            fireEvent.mouseEnter(element);
        });

        const popup = await screen.findByText("/very/long/expanded/path/to/project");
        expect(popup).toBeInTheDocument();
    });

    it("places the popup and arrow on the requested side", async () => {
        render(
            <TruncatedText force align="top" delay={0}>
                Clipped text
            </TruncatedText>,
        );

        const element = screen.getByText("Clipped text");

        await act(async () => {
            fireEvent.pointerEnter(element, { pointerType: "mouse" });
            fireEvent.mouseEnter(element);
        });

        const arrow = await waitFor(() => {
            const el = document.querySelector(".overflow-clip");
            expect(el).not.toBeNull();
            return el!;
        });
        expect(arrow.getAttribute("data-side")).toBe("top");
    });

    it("forwards custom ref to the span element", () => {
        let spanRef: HTMLSpanElement | null = null;
        render(
            <TruncatedText
                ref={(node) => {
                    spanRef = node;
                }}
            >
                Ref text
            </TruncatedText>,
        );

        expect(spanRef).not.toBeNull();
        expect((spanRef as HTMLSpanElement | null)?.textContent).toBe("Ref text");
    });
});
