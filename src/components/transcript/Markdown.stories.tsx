import type { Meta, StoryObj } from "@storybook/react-vite";
import rawFailures from "../../../src-tauri/tests/fixtures/failures-0.99.2.jsonl?raw";
import { lastAssistantText, parseFixture, streamedText } from "@/preview/fixtures";
import { Markdown } from "./Markdown";

/**
 * The smoke story of the preview pipeline: text comes from the recorded
 * `failures` fixture (real `pi --mode rpc` stdout) instead of invented copy.
 */
const recorded = parseFixture(rawFailures);
const finalText = lastAssistantText(recorded) ?? "";
const streamed = streamedText(recorded);

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
    args: { children: finalText },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The assistant turn as it settled, taken from `message_end`. */
export const AssistantText: Story = {};

/** The same turn rebuilt from `text_delta` streaming updates. */
export const StreamedDeltas: Story = {
    args: { children: streamed },
};

/** The full element mapping, for visual review of the typography scale. */
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
