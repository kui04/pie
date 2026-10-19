import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Attachments, type StagedImage } from "@/routes/chat/composer/Attachments";

const items: StagedImage[] = [
    {
        id: "attachment-1",
        name: "workspace.png",
        image: { type: "image", mimeType: "image/png", data: "A".repeat(2048) },
    },
    {
        id: "attachment-2",
        name: "sunset.jpg",
        image: { type: "image", mimeType: "image/jpeg", data: "AAAA" },
    },
];

describe("the pictures staged for a message", () => {
    it("names each picture, its kind, and its size", () => {
        render(<Attachments items={items} onRemove={() => undefined} />);

        expect(screen.getByRole("list", { name: "Attached images" })).toBeInTheDocument();
        expect(screen.getByText("workspace.png")).toBeInTheDocument();
        expect(screen.getByText("PNG · 1.5 KB")).toBeInTheDocument();
        expect(screen.getByText("sunset.jpg")).toBeInTheDocument();
        expect(screen.getByText("JPG · 3 B")).toBeInTheDocument();
    });

    it("removes the picture whose key was pressed", () => {
        const remove = vi.fn();
        render(<Attachments items={items} onRemove={remove} />);

        fireEvent.click(screen.getByRole("button", { name: "Remove sunset.jpg" }));

        expect(remove).toHaveBeenCalledWith("attachment-2");
    });
});

describe("the strip of pictures", () => {
    it("offers the key that follows the strip when it overruns", async () => {
        render(<Attachments items={items} onRemove={() => undefined} />);
        const strip = screen.getByRole("list", { name: "Attached images" });
        Object.defineProperties(strip, {
            clientWidth: { configurable: true, value: 300 },
            scrollWidth: { configurable: true, value: 600 },
            scrollLeft: { configurable: true, value: 0, writable: true },
        });
        fireEvent.scroll(strip);

        const right = await screen.findByRole("button", { name: "Scroll attachments right" });
        expect(screen.queryByRole("button", { name: "Scroll attachments left" })).toBeNull();
        const scroll = vi.fn();
        Object.defineProperty(strip, "scrollBy", { configurable: true, value: scroll });
        fireEvent.click(right);
        expect(scroll).toHaveBeenCalledWith({ left: 250, behavior: "smooth" });

        Object.defineProperty(strip, "scrollLeft", { configurable: true, value: 150, writable: true });
        fireEvent.scroll(strip);
        expect(await screen.findByRole("button", { name: "Scroll attachments left" })).toBeInTheDocument();
    });
});
