import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "@/components/Markdown";

const meta = {
    title: "Transcript/Markdown",
    component: Markdown,
    parameters: { layout: "padded" },
    decorators: [
        (Story) => (
            <div className="max-w-2xl">
                <Story />
            </div>
        ),
    ],
    args: {
        children: `The transcript runs on \`pi --mode rpc\`, and pie only ever sees the payloads
that come back over it.

A turn that needs a tool call will show the call and its result before the answer
lands, so a long pause is usually a tool running rather than a stalled session.

See [the protocol notes](https://example.com/protocol) for the full shape.`,
    },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An ordinary assistant turn: prose with inline code and a link. */
export const AssistantText: Story = {};

/** Every element the renderer maps, for review of the type scale. */
export const RichMarkdown: Story = {
    args: {
        children: `## Headings

A paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com).

### Lists

- first item
- second item with \`code\`

1. ordered one
2. ordered two

> A blockquote for context.

### Code

\`\`\`ts
export function greet(name: string): string {
    return \`hello \${name}\`;
}
\`\`\`

### Table

| command  | payload        |
| -------- | -------------- |
| get_state | SessionState   |
| get_entries | EntriesData |

---

Done.`,
    },
};
