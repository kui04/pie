/**
 * The attachments of one message: what the person staged, and the copies of the files on
 * their way to the machine that runs pi.
 *
 * A picture needs no step of its own, because pi takes it inline in the prompt. A file does.
 * It has to lie where pi runs, and when that machine is reached over SSH the file is
 * uploaded: progress, a wait, and a person who may change their mind halfway. That is the
 * flow this chart names (`.agents/rules/state.md`, Q4): `idle`, and `uploading` while at
 * least one copy is in flight.
 *
 * Each upload is a child actor, so that removing one card stops that one copy and leaves
 * the others alone, and so that a copy which ends closes its listener. That is what the
 * chart is for: the upload outlives the click that staged it, and nothing in the composer
 * reaches it otherwise.
 */

import { assign, enqueueActions, fromCallback, raise, setup, stopChild, type SnapshotFrom } from "xstate";
import { asPieError, type PieError, type PickedImage, type PreparedAttachment, type Unsubscribe } from "@/lib/bridge";
import type { RawPastedFile } from "@/lib/clipboard";
import type { ImageContent } from "@/lib/rpc-protocol";

/** One picture staged for a message. Pi takes it inline, so it never uploads. */
export interface StagedImageAttachment {
    id: string;
    type: "image";
    name: string;
    image: ImageContent;
}

/** One file staged for a message, and where its copy lies on the machine that runs pi. */
export interface StagedFileAttachment {
    id: string;
    type: "file";
    name: string;
    size: number;
    mimeType?: string;
    /** Where pi reads it: the path of the machine, once the copy has landed. */
    path: string;
    /** Whether the copy is still on its way. */
    uploading: boolean;
    /** How much of the copy is written, from 0 to 1. */
    progress?: number;
}

export type StagedAttachment = StagedImageAttachment | StagedFileAttachment;

/** The file that [`AttachmentDeps.prepare`] is asked to stage. */
export interface PrepareRequest {
    /** Names the progress events of this upload. */
    uploadId: string;
    name: string;
    localPath?: string;
    bytesBase64?: string;
}

/** What this chart needs from the outside world. */
export interface AttachmentDeps {
    /** Reads the progress of one upload, and answers the way to stop reading it. */
    progress: (uploadId: string, onProgress: (transferred: number, total: number) => void) => Promise<Unsubscribe>;
    /** Stages one file on the machine that runs pi, and answers where its copy lies. */
    prepare: (request: PrepareRequest) => Promise<PreparedAttachment>;
    /** Says that one file did not reach the machine. Its card goes. */
    notify: (failure: PieError) => void;
}

/** What the child of one upload says to the chart. */
type CopyEvent =
    | { type: "PROGRESS"; id: string; transferred: number; total: number }
    | { type: "READY"; id: string; prepared: PreparedAttachment }
    | { type: "FAILED"; id: string; failure: PieError };

type AttachmentEvent =
    | { type: "STAGE_IMAGES"; images: readonly PickedImage[] }
    | { type: "STAGE_FILES"; files: readonly RawPastedFile[] }
    /** The attachments of a message whose send pi refused come back, already staged. */
    | { type: "RESTORE"; items: readonly StagedAttachment[] }
    | CopyEvent
    | { type: "REMOVE"; id: string }
    | { type: "CLEAR" }
    /** Raised by this chart: the copies that ran have ended, so the mode is told again. */
    | { type: "SETTLE" };

type StageImagesEvent = Extract<AttachmentEvent, { type: "STAGE_IMAGES" }>;
type StageFilesEvent = Extract<AttachmentEvent, { type: "STAGE_FILES" }>;
type ProgressEvent = Extract<AttachmentEvent, { type: "PROGRESS" }>;
type ReadyEvent = Extract<AttachmentEvent, { type: "READY" }>;
type RemoveEvent = Extract<AttachmentEvent, { type: "REMOVE" }>;

interface AttachmentContext {
    deps: AttachmentDeps;
    items: readonly StagedAttachment[];
    /**
     * How many attachments this chart has staged. It names the next one, and the copy of it.
     *
     * A count and not a clock or a random name: the same steps must produce the same ids, or
     * a test cannot name the card that a step staged.
     */
    count: number;
}

/** One staged file, on its way to the machine that runs pi. */
const stageFile = fromCallback<CopyEvent, { id: string; request: PrepareRequest; deps: AttachmentDeps }>(
    ({ input, sendBack }) => {
        let alive = true;
        let off: Unsubscribe | undefined;
        const tell = (event: CopyEvent) => {
            if (alive) sendBack(event);
        };

        void (async () => {
            try {
                const unsubscribe = await input.deps.progress(input.request.uploadId, (transferred, total) => {
                    tell({ type: "PROGRESS", id: input.id, transferred, total });
                });
                // The copy can land before the listener is in place. Then nothing may stay open.
                if (alive) off = unsubscribe;
                else unsubscribe();
            } catch {
                // A listener that does not open costs the progress of this card, not the copy.
            }
        })();

        void input.deps.prepare(input.request).then(
            (prepared) => tell({ type: "READY", id: input.id, prepared }),
            (thrown: unknown) => tell({ type: "FAILED", id: input.id, failure: asPieError(thrown) }),
        );

        return () => {
            alive = false;
            off?.();
        };
    },
);

export const attachmentsMachine = setup({
    types: {
        context: {} as AttachmentContext,
        input: {} as { deps: AttachmentDeps },
        events: {} as AttachmentEvent,
    },
    actors: { stageFile },
    guards: {
        /** Whether no copy is on its way: the chart is idle. */
        settled: ({ context }) => !context.items.some((item) => item.type === "file" && item.uploading),
    },
    actions: {
        /** A message's pictures arrive complete: pi takes them as they are. */
        stageImages: assign({
            items: ({ context, event }) => [
                ...context.items,
                ...(event as StageImagesEvent).images.map(({ name, image }, at) => ({
                    id: `attachment-${context.count + at + 1}`,
                    type: "image" as const,
                    name,
                    image,
                })),
            ],
            count: ({ context, event }) => context.count + (event as StageImagesEvent).images.length,
        }),
        /**
         * A file is staged with its copy in one step. The card and the child carry one name,
         * and that name is what stops the child when the card goes.
         */
        stageFiles: assign(({ context, event, spawn }) => {
            const files = (event as StageFilesEvent).files;
            const added: StagedFileAttachment[] = files.map((file, at) => ({
                id: `attachment-${context.count + at + 1}`,
                type: "file",
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                path: file.localPath ?? "",
                uploading: true,
                progress: 0,
            }));
            added.forEach((item, at) => {
                const file = files[at];
                if (file === undefined) return;
                spawn("stageFile", {
                    id: item.id,
                    input: {
                        id: item.id,
                        request: {
                            uploadId: `upload-${context.count + at + 1}`,
                            name: file.name,
                            localPath: file.localPath,
                            bytesBase64: file.bytesBase64,
                        },
                        deps: context.deps,
                    },
                });
            });
            return {
                items: [...context.items, ...added],
                count: context.count + files.length,
            };
        }),
        /** One copy has written more of its file. */
        progress: assign({
            items: ({ context, event }) => {
                const { id, transferred, total } = event as ProgressEvent;
                return context.items.map((item) =>
                    item.id === id && item.type === "file"
                        ? { ...item, progress: total === 0 ? 1 : transferred / total }
                        : item,
                );
            },
        }),
        /** One copy landed: the card says where pi reads it from now on. */
        uploaded: assign({
            items: ({ context, event }) => {
                const { id, prepared } = event as ReadyEvent;
                return context.items.map((item) =>
                    item.id === id && item.type === "file"
                        ? {
                              ...item,
                              path: prepared.path,
                              size: prepared.size,
                              mimeType: prepared.mimeType,
                              uploading: false,
                              progress: 1,
                          }
                        : item,
                );
            },
        }),
        /** One copy failed: its card goes, because a file that never arrived cannot be sent. */
        failed: assign({
            items: ({ context, event }) =>
                context.items.filter((item) => item.id !== (event as { type: "FAILED"; id: string }).id),
        }),
        sayFailure: ({ context, event }) => {
            context.deps.notify((event as { type: "FAILED"; failure: PieError }).failure);
        },
        /**
         * Stops the copy of one card. It runs when the card goes and when the copy ends: a
         * `fromCallback` actor is never done on its own, so a copy that is left running keeps
         * its progress listener for the life of the window.
         */
        stopCopy: stopChild(({ event }) => (event as { id: string }).id),
        /** Stops every copy: the message went, or the person cleared the strip. */
        stopAllUploads: enqueueActions(({ self, enqueue }) => {
            for (const id of Object.keys(self.getSnapshot().children)) enqueue.stopChild(id);
        }),
        remove: assign({
            items: ({ context, event }) => context.items.filter((item) => item.id !== (event as RemoveEvent).id),
        }),
        clear: assign({
            items: () => [],
        }),
        restore: assign({
            items: ({ context, event }) => [
                ...context.items,
                ...(event as { type: "RESTORE"; items: readonly StagedAttachment[] }).items,
            ],
        }),
    },
}).createMachine({
    id: "attachments",
    context: ({ input }) => ({ deps: input.deps, items: [], count: 0 }),
    initial: "idle",
    on: {
        STAGE_IMAGES: { actions: "stageImages" },
        STAGE_FILES: { actions: ["stageFiles", raise({ type: "SETTLE" })] },
        RESTORE: { actions: "restore" },
        PROGRESS: { actions: "progress" },
        READY: { actions: ["uploaded", "stopCopy", raise({ type: "SETTLE" })] },
        FAILED: { actions: ["failed", "sayFailure", "stopCopy", raise({ type: "SETTLE" })] },
        REMOVE: { actions: ["stopCopy", "remove", raise({ type: "SETTLE" })] },
        CLEAR: { actions: ["stopAllUploads", "clear", raise({ type: "SETTLE" })] },
        SETTLE: [{ guard: "settled", target: "#idle" }, { target: "#uploading" }],
    },
    states: {
        idle: { id: "idle" },
        uploading: { id: "uploading" },
    },
});

/** The attachments a snapshot holds, for the screen that draws them. */
export function itemsOf(snapshot: SnapshotFrom<typeof attachmentsMachine>): readonly StagedAttachment[] {
    return snapshot.context.items;
}

/** Whether at least one copy is still on its way: the message may not go yet. */
export function uploadingOf(snapshot: SnapshotFrom<typeof attachmentsMachine>): boolean {
    return snapshot.matches("uploading");
}
