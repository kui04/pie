import { afterEach, describe, expect, it, vi } from "vitest";
import {
    blobToBase64,
    copyText,
    extractFiles,
    extractUris,
    hasFilesOrUris,
    readClipboard,
    readText,
} from "@/lib/clipboard";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("copying text", () => {
    it("writes with the Web Clipboard API", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });

        await expect(copyText("hello")).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith("hello");
    });

    it("returns false when the Web Clipboard API is absent or rejects", async () => {
        vi.stubGlobal("navigator", {});
        await expect(copyText("hello")).resolves.toBe(false);

        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        await expect(copyText("hello")).resolves.toBe(false);
    });
});

describe("reading text", () => {
    it("reads from paste DataTransfer first when present", async () => {
        const readTextMock = vi.fn().mockResolvedValue("from web clipboard");
        vi.stubGlobal("navigator", { clipboard: { readText: readTextMock } });

        const transfer = {
            getData: (type: string) => (type === "text/plain" ? "from paste event" : ""),
        } as unknown as DataTransfer;

        await expect(readText(transfer)).resolves.toBe("from paste event");
        expect(readTextMock).not.toHaveBeenCalled();
    });

    it("falls back to navigator.clipboard.readText when DataTransfer has no text", async () => {
        const readTextMock = vi.fn().mockResolvedValue("from web clipboard");
        vi.stubGlobal("navigator", { clipboard: { readText: readTextMock } });

        await expect(readText()).resolves.toBe("from web clipboard");
    });

    it("returns null when both DataTransfer and Web Clipboard API are unavailable", async () => {
        const readTextMock = vi.fn().mockRejectedValue(new Error("denied"));
        vi.stubGlobal("navigator", { clipboard: { readText: readTextMock } });

        await expect(readText()).resolves.toBeNull();
    });
});

describe("blob conversion", () => {
    it("converts blob to base64 without data URI prefix", async () => {
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

        expect(extractFiles(transfer)).toHaveLength(2);
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

        const files = extractFiles(transfer);
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe("screenshot.png");
    });

    it("extracts file URIs and pure path lines while ignoring prose and comments", () => {
        const uriTransfer = {
            files: [],
            items: [],
            getData: (format: string) => {
                if (format === "text/uri-list") {
                    return "file:///tmp/pic.png\r\n# comment\r\ncontent://com.android.providers.media/1\r\nhttps://example.com/a.png";
                }
                return "";
            },
        } as unknown as DataTransfer;

        expect(extractUris(uriTransfer)).toEqual(["file:///tmp/pic.png", "content://com.android.providers.media/1"]);
        expect(hasFilesOrUris(uriTransfer)).toBe(true);

        const pathTransfer = {
            files: [],
            items: [],
            getData: (format: string) => {
                if (format === "text/plain") {
                    return "/home/user/test.png\nC:\\Users\\me\\doc.pdf\n//server/share/a.txt\n\\\\server\\share\\b.txt";
                }
                return "";
            },
        } as unknown as DataTransfer;

        expect(extractUris(pathTransfer)).toEqual([
            "/home/user/test.png",
            "C:\\Users\\me\\doc.pdf",
            "//server/share/a.txt",
            "\\\\server\\share\\b.txt",
        ]);
        expect(hasFilesOrUris(pathTransfer)).toBe(true);

        const proseWithSlash = {
            files: [],
            items: [],
            getData: (format: string) => {
                if (format === "text/plain") return "/home/user/test.png\nother words";
                return "";
            },
        } as unknown as DataTransfer;

        expect(extractUris(proseWithSlash)).toEqual([]);
        expect(hasFilesOrUris(proseWithSlash)).toBe(false);
    });

    it("returns empty array and false when transfer has only plain text", () => {
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

        expect(hasFilesOrUris(transfer)).toBe(false);
        expect(extractFiles(transfer)).toHaveLength(0);
    });

    it("handles null transfer safely", () => {
        expect(hasFilesOrUris(null)).toBe(false);
        expect(extractFiles(null)).toBeInstanceOf(Array);
        expect(extractUris(null)).toEqual([]);
    });
});

describe("readClipboard", () => {
    it("reads and encodes images, files, and URIs from paste DataTransfer first", async () => {
        const read = vi.fn();
        vi.stubGlobal("navigator", { clipboard: { read } });

        const img = new File(["img-bytes"], "cat.png", { type: "image/png" });
        const pdf = new File(["pdf-bytes"], "notes.pdf", { type: "application/pdf" });
        const transfer = {
            files: [img, pdf],
            items: [],
            getData: (type: string) => (type === "text/uri-list" ? "file:///home/user/extra.pdf" : ""),
        } as unknown as DataTransfer;

        const result = await readClipboard(transfer);
        expect(read).not.toHaveBeenCalled();
        expect(result.images).toHaveLength(1);
        expect(result.images[0].name).toBe("cat.png");
        expect(result.files).toHaveLength(1);
        expect(result.files[0].name).toBe("notes.pdf");
        expect(result.files[0].bytesBase64).toBeTruthy();
        expect(result.uris).toEqual(["file:///home/user/extra.pdf"]);
    });

    it("falls back to navigator.clipboard.read when DataTransfer is empty", async () => {
        const pngBlob = new Blob(["png-bytes"], { type: "image/png" });
        const uriBlob = new Blob(["file:///home/user/doc.pdf"], { type: "text/uri-list" });
        const read = vi.fn().mockResolvedValue([
            {
                types: ["image/png", "text/uri-list"],
                getType: vi.fn((type: string) => Promise.resolve(type === "image/png" ? pngBlob : uriBlob)),
            },
        ]);
        vi.stubGlobal("navigator", { clipboard: { read } });

        const emptyTransfer = {
            files: [],
            items: [],
            getData: () => "",
        } as unknown as DataTransfer;

        const result = await readClipboard(emptyTransfer);
        expect(read).toHaveBeenCalledTimes(1);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].mimeType).toBe("image/png");
        expect(result.uris).toEqual(["file:///home/user/doc.pdf"]);
    });
});
