import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import type { PieError, PreparedAttachment } from "@/lib/bridge";
import {
    attachmentsMachine,
    itemsOf,
    uploadingOf,
    type AttachmentDeps,
    type PrepareRequest,
    type StagedAttachment,
} from "@/machines/attachments.machine";

/**
 * The attachments of one message, driven by events only. Staging a file is a step of this
 * flow, so the copy arrives as a dep: a test says when it lands, and needs no Tauri runtime.
 *
 * The walk of the paths of this chart (`@xstate/graph`) is not used here: a copy moves the
 * mode only when it answers, and the walk has no clock to wait for that answer.
 */

/** One staged file, as the commands answer them. */
const file = (name: string) => ({ name, size: 4, mimeType: "text/plain", localPath: `/tmp/${name}` });

const picture = { type: "image" as const, data: "aGk=", mimeType: "image/png" };

function harness() {
    const pending = new Map<
        string,
        { land: (prepared: PreparedAttachment) => void; fail: (failure: PieError) => void }
    >();
    const reporters = new Map<string, (transferred: number, total: number) => void>();
    const stopped: string[] = [];
    const told: PieError[] = [];
    let started = 0;

    const deps: AttachmentDeps = {
        progress: async (uploadId, onProgress) => {
            reporters.set(uploadId, onProgress);
            return () => {
                stopped.push(uploadId);
            };
        },
        prepare: (request: PrepareRequest) => {
            started += 1;
            return new Promise<PreparedAttachment>((land, fail) => {
                pending.set(request.uploadId, { land, fail });
            });
        },
        notify: (failure) => told.push(failure),
    };

    const actor = createActor(attachmentsMachine, { input: { deps } }).start();
    return { actor, pending, reporters, stopped, told, started: () => started };
}

const refusal: PieError = { kind: "bad_argument", message: "the file was refused" };

describe("the attachments of a message", () => {
    it("starts with none, and stays idle while a picture is staged", () => {
        const { actor, started } = harness();

        expect(itemsOf(actor.getSnapshot())).toEqual([]);
        expect(uploadingOf(actor.getSnapshot())).toBe(false);

        actor.send({ type: "STAGE_IMAGES", images: [{ name: "shot.png", image: picture }] });

        expect(itemsOf(actor.getSnapshot())).toMatchObject([
            { id: "attachment-1", type: "image", name: "shot.png", image: picture },
        ]);
        // A picture needs no copy: pi takes it inline.
        expect(uploadingOf(actor.getSnapshot())).toBe(false);
        expect(started()).toBe(0);
    });

    it("stages a file as a copy on its way, and settles it when the copy lands", async () => {
        const { actor, pending, stopped } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("report.pdf")] });

        expect(uploadingOf(actor.getSnapshot())).toBe(true);
        expect(itemsOf(actor.getSnapshot())).toMatchObject([
            { id: "attachment-1", type: "file", uploading: true, path: "/tmp/report.pdf", progress: 0 },
        ]);

        pending.get("upload-1")?.land({ path: "/tmp/pie-report-1.pdf", size: 12, mimeType: "application/pdf" });

        await vi.waitFor(() => expect(uploadingOf(actor.getSnapshot())).toBe(false));
        // The card says where pi reads the file, and the size of the copy that lies there.
        expect(itemsOf(actor.getSnapshot())).toMatchObject([
            { path: "/tmp/pie-report-1.pdf", size: 12, mimeType: "application/pdf", uploading: false, progress: 1 },
        ]);
        // A copy that ended closes its listener: a child of this chart is never done on its own.
        await vi.waitFor(() => expect(stopped).toEqual(["upload-1"]));
    });

    it("gives two pictures staged together two names", () => {
        const { actor } = harness();

        actor.send({
            type: "STAGE_IMAGES",
            images: [
                { name: "one.png", image: picture },
                { name: "two.png", image: picture },
            ],
        });

        expect(itemsOf(actor.getSnapshot()).map((item) => item.id)).toEqual(["attachment-1", "attachment-2"]);
    });

    it("gives two attachments of one name two names", () => {
        const { actor } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("notes.txt"), file("notes.txt")] });

        expect(itemsOf(actor.getSnapshot()).map((item) => item.id)).toEqual(["attachment-1", "attachment-2"]);
    });

    it("moves the progress of one copy, and leaves the other where it is", () => {
        const { actor, reporters } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("a.txt"), file("b.txt")] });
        reporters.get("upload-1")?.(3, 12);

        const progress = itemsOf(actor.getSnapshot()).map((item) => (item.type === "file" ? item.progress : null));
        expect(progress).toEqual([0.25, 0]);
    });

    it("stops the copy of a card the person removes", async () => {
        const { actor, stopped } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("a.txt"), file("b.txt")] });
        actor.send({ type: "REMOVE", id: "attachment-1" });

        await vi.waitFor(() => expect(stopped).toContain("upload-1"));
        expect(itemsOf(actor.getSnapshot()).map((item) => item.id)).toEqual(["attachment-2"]);
        // One copy still runs, so the message may not go yet.
        expect(uploadingOf(actor.getSnapshot())).toBe(true);
    });

    it("is idle again when the only copy in flight was removed", () => {
        const { actor } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("a.txt")] });
        actor.send({ type: "REMOVE", id: "attachment-1" });

        expect(uploadingOf(actor.getSnapshot())).toBe(false);
        expect(itemsOf(actor.getSnapshot())).toEqual([]);
    });

    it("drops the card of a copy that failed, and says why", async () => {
        const { actor, pending, stopped, told } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("a.txt")] });
        pending.get("upload-1")?.fail(refusal);

        await vi.waitFor(() => expect(itemsOf(actor.getSnapshot())).toEqual([]));
        expect(told).toEqual([refusal]);
        expect(uploadingOf(actor.getSnapshot())).toBe(false);
        await vi.waitFor(() => expect(stopped).toEqual(["upload-1"]));
    });

    it("clears the strip and stops every copy", async () => {
        const { actor, stopped } = harness();

        actor.send({ type: "STAGE_FILES", files: [file("a.txt"), file("b.txt")] });
        actor.send({ type: "CLEAR" });

        await vi.waitFor(() => expect(stopped).toEqual(expect.arrayContaining(["upload-1", "upload-2"])));
        expect(itemsOf(actor.getSnapshot())).toEqual([]);
        expect(uploadingOf(actor.getSnapshot())).toBe(false);
    });

    it("puts the attachments of a refused message back without copying them again", () => {
        const { actor, started } = harness();
        const landed: StagedAttachment = {
            id: "attachment-9",
            type: "file",
            name: "a.txt",
            size: 4,
            mimeType: "text/plain",
            path: "/tmp/pie-a.txt",
            uploading: false,
            progress: 1,
        };

        actor.send({ type: "RESTORE", items: [landed] });

        expect(itemsOf(actor.getSnapshot())).toEqual([landed]);
        expect(uploadingOf(actor.getSnapshot())).toBe(false);
        expect(started()).toBe(0);
    });
});
