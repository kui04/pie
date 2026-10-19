import type { Meta, StoryObj } from "@storybook/react-vite";
import { Attachments, type StagedImage } from "@/routes/chat/composer/Attachments";

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

const items: StagedImage[] = [
    {
        id: "attachment-1",
        name: "workspace.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#4daafc", "#005fb8") },
    },
    {
        id: "attachment-2",
        name: "sunset.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#f88070", "#b180d7") },
    },
    {
        id: "attachment-3",
        name: "diagram.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#81b88b", "#cca700") },
    },
    {
        id: "attachment-4",
        name: "chart.svg",
        image: { type: "image", mimeType: "image/svg+xml", data: thumbnail("#c586c0", "#0078d4") },
    },
];

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
