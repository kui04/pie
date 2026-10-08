import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UserMessage as UserMessageData } from "@/lib/protocol";
import { UserMessage } from "@/routes/chat/components/entries/UserMessage";

/** What the reader asked, on their side of the transcript. */

const meta = {
    title: "Transcript/UserMessage",
    component: UserMessage,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="flex w-full max-w-2xl flex-col p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof UserMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

const asked = (message: Partial<UserMessageData>): UserMessageData =>
    ({ role: "user", content: "Make the parser skip empty lines.", timestamp: 0, ...message }) as UserMessageData;

/** One line, in the tighter box every short message takes. */
export const OneLine: Story = {
    args: { id: "story-user", message: asked({}) },
};

/** Several lines, in the box a paragraph takes. */
export const SeveralLines: Story = {
    args: {
        id: "story-user-many",
        message: asked({
            content: "Make the parser skip empty lines.\nAnd run the tests, please.\nThe changelog can wait.",
        }),
    },
};

/** A small drawing, base64, as the wire carries an image. */
const SHAPE =
    "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTQwIj48cmVjdCB3aWR0aD0iMjQwIiBoZWlnaHQ9IjE0MCIgZmlsbD0iIzJhMmEyYSIvPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjExMCIgaGVpZ2h0PSIxMDgiIGZpbGw9IiMxZjFmMWYiLz48cmVjdCB4PSIxNDAiIHk9IjE2IiB3aWR0aD0iODQiIGhlaWdodD0iNDAiIGZpbGw9IiM0NzQ3NDYiLz48cmVjdCB4PSIxNDAiIHk9IjY4IiB3aWR0aD0iODQiIGhlaWdodD0iNTYiIGZpbGw9IiMzNTM1MzUiLz48L3N2Zz4=";

/** A request with a picture, which sits above its words. */
export const WithImage: Story = {
    args: {
        id: "story-user-image",
        message: asked({
            content: [
                { type: "text", text: "What is wrong with this layout?" },
                // A picture the story can carry inside itself, so that it needs
                // no asset: a real one arrives from pi as raster data.
                { type: "image", mimeType: "image/svg+xml", data: SHAPE },
            ],
        }),
    },
};
