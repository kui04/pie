import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { ToolResultMessage } from "@/lib/rpc-protocol";
import { presentCall } from "@/routes/chat/components/toolPresentation";
import { ToolResultCard } from "@/routes/chat/components/entries/ToolResultCard";

/** A tool call and what it answered, in the four forms a body takes. */

const meta = {
    title: "Transcript/ToolResultCard",
    component: ToolResultCard,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-2xl p-4 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof ToolResultCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A diff of an edit: pi's own display diff, line numbers and all. */
export const Diff: Story = {
    args: {
        id: "story-diff",
        presentation: presentCall("edit", { path: "~/work/parse.ts" }, {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "edit",
            content: [{ type: "text", text: "the file was written" }],
            details: {
                diff: [
                    "  12 export function parse(text: string) {",
                    '- 13     return text.split("\\n");',
                    '+ 13     return text.split("\\n").filter(Boolean);',
                    "  14 }",
                ].join("\n"),
            },
            isError: false,
            timestamp: 0,
        } satisfies ToolResultMessage),
    },
};

/** A long output, which a closed card reads from its end. */
export const Log: Story = {
    args: {
        id: "story-log",
        presentation: presentCall("bash", { command: "pnpm test" }, answered(12)),
    },
};

/**
 * A header longer than the card: the words stay on one line and end in an ellipsis,
 * because the state of the call and its clock sit at the end of the same line.
 */
export const LongHeader: Story = {
    args: {
        id: "story-long-header",
        presentation: presentCall(
            "read",
            {
                path: "~/.pi/agent/sessions/-home-kui-projects-pie-with-a-rather-long-name/2026-10-07T14-58-00-000Z_0199e1a0-0000-7000-8000-000000000000.jsonl",
            },
            {
                role: "toolResult",
                toolCallId: "c1",
                toolName: "read",
                content: [{ type: "text", text: "the head of the file\nthe rest of it" }],
                isError: false,
                timestamp: 0,
            } satisfies ToolResultMessage,
        ),
    },
};

/** A file, numbered from where the read started. */
export const File: Story = {
    args: {
        id: "story-file",
        presentation: presentCall("read", { path: "~/work/notes.md", offset: 40 }, {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "read",
            content: [{ type: "text", text: "the notes\ncontinue here\nand here" }],
            isError: false,
            timestamp: 0,
        } satisfies ToolResultMessage),
    },
};

/** A call that failed. */
export const Failed: Story = {
    args: {
        id: "story-failed",
        presentation: presentCall(
            "bash",
            { command: "cat /nowhere" },
            failed("cat: /nowhere: No such file or directory"),
        ),
    },
};

/** A call whose answer has not come, in a turn that has settled: it waits. */
export const Waiting: Story = {
    args: {
        id: "story-waiting",
        presentation: presentCall("bash", { command: "pnpm build" }, null),
    },
};

/** The same call inside a turn the model is still writing: it runs, and a clock. */
export const Running: Story = {
    args: {
        id: "story-running",
        presentation: presentCall("bash", { command: "pnpm build" }, null, true),
    },
};

/**
 * The one way a `Took` can exist: a card that drew the call running, and then
 * saw it settle. A transcript that only replays a session has no such card, and
 * pi's own transcript shows no duration there either - which is why this story
 * plays the change rather than taking a finished call as its argument.
 */
export const Completed: Story = {
    // The arguments are the signature of the story; the render below plays the
    // change, because the value that matters is one only a clock can give.
    args: {
        id: "story-completed",
        presentation: presentCall("bash", { command: "pnpm test" }, null, true),
    },
    render: () => <Completing />,
};

function Completing() {
    const [done, setDone] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setDone(true), 2500);
        return () => clearTimeout(timer);
    }, []);
    return (
        <ToolResultCard
            id="story-completed"
            presentation={presentCall("bash", { command: "pnpm test" }, done ? answered(12) : null, !done)}
        />
    );
}

/** What a tool of a pi release this build does not know reads as. */
export const UnknownTool: Story = {
    args: {
        id: "story-unknown",
        presentation: presentCall("web_search", { query: "tauri 2 events", count: 5 }, answered(3)),
    },
};

/** A result whose output is `count` lines long. */
function answered(count: number, overrides: Partial<Omit<ToolResultMessage, "role">> = {}): ToolResultMessage {
    const text = Array.from({ length: count }, (_, index) => `test ${index + 1} ... ok`).join("\n");
    return {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
        ...overrides,
    };
}

/** A result that failed, with the text of the failure. */
function failed(text: string): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: true,
        timestamp: 0,
    };
}
