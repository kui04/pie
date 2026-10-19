import type { Meta, StoryObj } from "@storybook/react-vite";
import { CallRow } from "@/routes/chat/transcript/entries/CallRow";
import { presentCall } from "@/routes/chat/transcript/presentation";
import { toolResult } from "@/preview/fixtures";

/**
 * One call the model made, as the transcript draws it: a single line until a
 * reader asks for what it produced.
 *
 * The states a row takes are what these draw - a command that logs, an edit
 * that diffs, a failure, and a call at work. A command the reader ran
 * themselves is `Transcript/UserCommand`.
 */
const meta = {
    title: "Transcript/CallRow",
    component: CallRow,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-3xl bg-surface p-6 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof CallRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const diff = [
    "  41 export function parse(text: string) {",
    '-  42     return text.split("\\n").map((line) => line.trim());',
    '+  42     const lines = text.split("\\n").map((line) => line.trim());',
    "+  43     return lines.filter((line) => line.length > 0);",
    "  44 }",
];

/** A command, answered: one line, with pi's own clock at its end. */
export const Log: Story = {
    args: {
        id: "c1",
        tool: "bash",
        quote: true,
        presentation: presentCall(
            "bash",
            { command: "pnpm test -- parse" },
            toolResult(
                "c1",
                "bash",
                "> vitest run -- parse\n\n ✓ parse.test.ts (14 tests) 12ms\n\n Tests  36 passed (36)",
                {
                    durationMs: 1240,
                },
            ),
        ),
    },
};

/** An edit, answered: the row is a line, and the diff waits behind it. */
export const Diff: Story = {
    args: {
        id: "c2",
        tool: "edit",
        quote: true,
        presentation: presentCall(
            "edit",
            { path: "src/lib/parse.ts" },
            toolResult("c2", "edit", "Applied 1 edit.\n\n" + diff.join("\n"), { details: { diff: diff.join("\n") } }),
        ),
    },
};

/** A call that failed: its mark, its notes, and the output it left. */
export const Failed: Story = {
    args: {
        id: "c3",
        tool: "bash",
        quote: true,
        presentation: presentCall(
            "bash",
            { command: "pnpm test" },
            toolResult("c3", "bash", "boom", { isError: true, durationMs: 900 }),
        ),
    },
};

/** A call at work: it is open while it runs, and folds itself when its result lands. */
export const Running: Story = {
    args: {
        id: "c4",
        tool: "bash",
        quote: true,
        presentation: presentCall(
            "bash",
            { command: "pnpm build" },
            toolResult("c4", "bash", "vite v8.0.0 building for production..."),
            true,
            true,
        ),
    },
};
