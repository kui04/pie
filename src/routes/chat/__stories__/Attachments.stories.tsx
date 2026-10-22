import type { Meta, StoryObj } from "@storybook/react-vite";
import type { StagedAttachment } from "@/machines/attachments.machine";
import { Attachments } from "@/routes/chat/composer/Attachments";

/** A thumbnail the strip can draw without a file: a picture of two colours. */
function thumbnail(from: string, to: string) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
        </linearGradient></defs>
        <rect width="120" height="120" fill="url(#g)"/>
        <circle cx="88" cy="32" r="18" fill="#ffffff" fill-opacity=".55"/>
    </svg>`;
    return btoa(svg);
}

const items: StagedAttachment[] = [
    {
        id: "attachment-1",
        type: "image",
        name: "workspace.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#4daafc", "#005fb8") },
    },
    {
        id: "attachment-2",
        type: "image",
        name: "sunset.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#f88070", "#b180d7") },
    },
    {
        id: "attachment-3",
        type: "image",
        name: "diagram.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#81b88b", "#cca700") },
    },
    {
        id: "attachment-4",
        type: "image",
        name: "chart.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#c586c0", "#0078d4") },
    },
];

const files: StagedAttachment[] = [
    {
        id: "file-1",
        type: "file",
        name: "architecture-proposal.pdf",
        size: 1024 * 1024 * 2.4,
        mimeType: "application/pdf",
        path: "/home/user/docs/architecture-proposal.pdf",
        uploading: false,
    },
    {
        id: "file-2",
        type: "file",
        name: "schema.json",
        size: 14200,
        mimeType: "application/json",
        path: "/home/user/code/schema.json",
        uploading: false,
    },
];

const uploading: StagedAttachment[] = [
    {
        id: "uploading-1",
        type: "file",
        name: "large-dataset.sqlite",
        size: 1024 * 1024 * 18.5,
        mimeType: "application/octet-stream",
        path: "/tmp/pie-large-dataset.sqlite",
        uploading: true,
        progress: 0.62,
    },
    {
        id: "uploading-2",
        type: "file",
        name: "trace.log",
        size: 1024 * 512,
        mimeType: "text/plain",
        path: "/tmp/pie-trace.log",
        uploading: true,
        progress: 0.25,
    },
];

const mixed: StagedAttachment[] = [items[0], files[0], uploading[0], files[1]];

const meta = {
    title: "Chat/Composer attachments",
    component: Attachments,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => (
            <div className="min-h-80 bg-surface p-6 font-sans">
                <div className="mx-auto w-full max-w-5xl">
                    <Story />
                </div>
            </div>
        ),
    ],
    args: { items, onRemove: () => undefined },
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Four pictures: one row, with the gradient and the key that reveal the rest. */
export const Strip: Story = {};

/** Non-image files: document and data cards with icons and file sizes. */
export const Files: Story = {
    args: { items: files },
};

/** Remote uploads in progress: cards covered by the transitioning progress mask. */
export const Uploading: Story = {
    args: { items: uploading },
};

/** Mixed strip: pictures, local files, and an active upload together. */
export const Mixed: Story = {
    args: { items: mixed },
};
