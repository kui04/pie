import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Bridge from "@/lib/bridge";
import {
    blobToBase64,
    copyText,
    extractAllFiles,
    extractUris,
    hasPastedFilesOrUris,
    processPaste,
    readText,
} from "@/lib/clipboard";

type Call = (...args: unknown[]) => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    importPaths: vi.fn<Call>(),
    onUploadProgress: vi.fn<Call>(),
    prepareAttachment: vi.fn<Call>(),
    readClipboard: vi.fn<Call>(),
    readClipboardText: vi.fn<Call>(),
    writeClipboardText: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

beforeEach(() => {
    vi.clearAllMocks();
});

describe("copying text", () => {
    it("answers true when the text lands", async () => {
        bridge.writeClipboardText.mockResolvedValue(undefined);

        await expect(copyText("hello")).resolves.toBe(true);
        expect(bridge.writeClipboardText).toHaveBeenCalledWith("hello");
    });

    it("answers false when the clipboard refuses", async () => {
        bridge.writeClipboardText.mockRejectedValue(new Error("denied"));

        await expect(copyText("hello")).resolves.toBe(false);
    });
});

describe("reading text", () => {
    it("returns text when readClipboardText succeeds", async () => {
        bridge.readClipboardText.mockResolvedValue("clipboard text");

        await expect(readText()).resolves.toBe("clipboard text");
    });

    it("returns null when readClipboardText rejects or throws", async () => {
        bridge.readClipboardText.mockRejectedValue(new Error("denied"));

        await expect(readText()).resolves.toBeNull();
    });
});

describe("blob conversion", () => {
    it("converts blob to base64 without data prefix", async () => {
        const blob = new Blob(["sample bytes"], { type: "image/png" });
        const b64 = await blobToBase64(blob);

        expect(typeof b64).toBe("string");
        expect(b64).not.toContain("data:");
    });
});

describe("inspecting and extracting from DataTransfer", () => {
    it("extracts all files from transfer.files", () => {
        const img = new File([], "cat.png", { type: "image/png" });
        const doc = new File([], "report.pdf", { type: "application/pdf" });
        const transfer = {
            files: [img, doc],
            items: [],
            getData: () => "",
        } as unknown as DataTransfer;

        expect(extractAllFiles(transfer)).toHaveLength(2);
    });

    it("extracts all files from transfer.items", () => {
        const mockFile = new File([], "screenshot.png", { type: "image/png" });
        const transfer = {
            files: [],
            items: [
                {
                    kind: "file",
                    type: "image/png",
                    getAsFile: () => mockFile,
                },
            ],
            getData: () => "",
        } as unknown as DataTransfer;

        const files = extractAllFiles(transfer);
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe("screenshot.png");
    });

    it("extracts URIs from text/uri-list and plain paths", () => {
        const uriTransfer = {
            files: [],
            items: [],
            getData: (format: string) => {
                if (format === "text/uri-list") return "file:///tmp/pic.png\r\n# comment\r\nfile:///tmp/doc.pdf";
                return "";
            },
        } as unknown as DataTransfer;

        expect(extractUris(uriTransfer)).toEqual(["file:///tmp/pic.png", "file:///tmp/doc.pdf"]);
        expect(hasPastedFilesOrUris(uriTransfer)).toBe(true);

        const pathTransfer = {
            files: [],
            items: [],
            getData: (format: string) => {
                if (format === "text/plain") return "/home/user/test.png\nother words";
                return "";
            },
        } as unknown as DataTransfer;

        expect(extractUris(pathTransfer)).toEqual(["/home/user/test.png"]);
    });

    it("returns empty array and false when transfer has only text", () => {
        const transfer = {
            files: [],
            items: [
                {
                    kind: "string",
                    type: "text/plain",
                    getAsFile: () => null,
                },
            ],
            getData: (type: string) => (type === "text/plain" ? "just plain text" : ""),
        } as unknown as DataTransfer;

        expect(hasPastedFilesOrUris(transfer)).toBe(false);
        expect(extractAllFiles(transfer)).toHaveLength(0);
    });

    it("handles null transfer safely", () => {
        expect(hasPastedFilesOrUris(null)).toBe(false);
        expect(extractAllFiles(null)).toHaveLength(0);
        expect(extractUris(null)).toHaveLength(0);
    });
});

describe("universal processPaste workflow", () => {
    it("handles DOM files with image and non-image files", async () => {
        const img = new File(["img-bytes"], "cat.png", { type: "image/png" });
        const pdf = new File(["pdf-bytes"], "notes.pdf", { type: "application/pdf" });

        const transfer = {
            files: [img, pdf],
            items: [],
            getData: () => "",
        } as unknown as DataTransfer;

        const result = await processPaste(transfer);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].name).toBe("cat.png");
        expect(result.files).toHaveLength(1);
        expect(result.files[0].name).toBe("notes.pdf");
        expect(result.files[0].bytesBase64).toBeDefined();
    });

    it("imports URIs when text/uri-list is present", async () => {
        bridge.importPaths.mockResolvedValue({
            images: [{ name: "photo.png", image: { type: "image", data: "b64", mimeType: "image/png" } }],
            files: [
                { name: "document.pdf", size: 100, mimeType: "application/pdf", localPath: "/home/user/document.pdf" },
            ],
        });

        const transfer = {
            files: [],
            items: [],
            getData: (type: string) =>
                type === "text/uri-list" ? "file:///home/user/photo.png\r\nfile:///home/user/document.pdf" : "",
        } as unknown as DataTransfer;

        const result = await processPaste(transfer);
        expect(result.images).toHaveLength(1);
        expect(result.files).toHaveLength(1);
        expect(result.files[0].localPath).toBe("/home/user/document.pdf");
        expect(bridge.importPaths).toHaveBeenCalledWith([
            "file:///home/user/photo.png",
            "file:///home/user/document.pdf",
        ]);
    });

    it("falls back to native clipboard content when transfer is empty", async () => {
        bridge.readClipboard.mockResolvedValue({
            images: [{ name: "Pasted image", image: { type: "image", data: "b64", mimeType: "image/png" } }],
            files: [],
        });

        const transfer = {
            files: [],
            items: [],
            getData: () => "",
        } as unknown as DataTransfer;

        const result = await processPaste(transfer);
        expect(result.images).toHaveLength(1);
        expect(bridge.readClipboard).toHaveBeenCalled();
    });
});
