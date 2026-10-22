import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StagedAttachment } from "@/machines/attachments.machine";
import { Attachments } from "@/routes/chat/composer/Attachments";

const items: StagedAttachment[] = [
    {
        id: "attachment-1",
        type: "image",
        name: "workspace.png",
        image: { type: "image", mimeType: "image/png", data: "A".repeat(2048) },
    },
    {
        id: "attachment-2",
        type: "image",
        name: "sunset.jpg",
        image: { type: "image", mimeType: "image/jpeg", data: "AAAA" },
    },
];

describe("the pictures staged for a message", () => {
    it("names each picture, its kind, and its size", () => {
        render(<Attachments items={items} onRemove={() => undefined} />);

        expect(screen.getByRole("list", { name: "Attachments" })).toBeInTheDocument();
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

    it("displays files with size and uploading progress mask", () => {
        const fileItems: StagedAttachment[] = [
            {
                id: "file-1",
                type: "file",
                name: "document.pdf",
                size: 2048,
                mimeType: "application/pdf",
                path: "/tmp/pie-document.pdf",
                uploading: true,
                progress: 0.65,
            },
            {
                id: "file-2",
                type: "file",
                name: "report.txt",
                size: 512,
                mimeType: "text/plain",
                path: "/home/user/report.txt",
                uploading: false,
                progress: 1,
            },
        ];

        render(<Attachments items={fileItems} onRemove={() => undefined} />);

        expect(screen.getByText("document.pdf")).toBeInTheDocument();
        expect(screen.getByText("Uploading · 2.0 KB")).toBeInTheDocument();
        expect(screen.getByText("65%")).toBeInTheDocument();

        expect(screen.getByText("report.txt")).toBeInTheDocument();
        expect(screen.getByText("TXT · 512 B")).toBeInTheDocument();
    });
});

describe("the strip of pictures", () => {
    it("offers the key that follows the strip when it overruns", async () => {
        render(<Attachments items={items} onRemove={() => undefined} />);
        const strip = document.querySelector("[data-slot=scroll-area-viewport]");
        if (!(strip instanceof HTMLElement)) throw new Error("no strip viewport");
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
