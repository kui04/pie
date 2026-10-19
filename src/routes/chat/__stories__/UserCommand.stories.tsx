import type { Meta, StoryObj } from "@storybook/react-vite";
import { UserCommand } from "@/routes/chat/transcript/entries/UserCommand";
import { presentExecution, presentRunningExecution } from "@/routes/chat/transcript/presentation";
import { bashExecution } from "@/preview/fixtures";

/**
 * One command the reader ran themselves, as the transcript draws it: pi's own
 * prompt, in the colour of their own run.
 */
const meta = {
    title: "Transcript/UserCommand",
    component: UserCommand,
    decorators: [
        (Story: React.ComponentType) => (
            <div className="w-full max-w-3xl bg-surface p-6 font-sans">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof UserCommand>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A command the reader ran: pi's own prompt, in the colour of their own run. */
export const ReaderRun: Story = {
    args: {
        id: "c5",
        tool: "bash",
        quote: true,
        presentation: presentExecution(bashExecution("ls -la src/lib", "parse.ts\ntext.ts\ntranscript.ts")),
    },
};

/** A command at work: it is open while it runs, and folds itself when it settles. */
export const Running: Story = {
    args: {
        id: "c6",
        tool: "bash",
        quote: true,
        presentation: presentRunningExecution({
            command: "pnpm build",
            output: [
                "vite v8.0.0 building for production...",
                "transforming (1284) src/routes/chat/transcript/entries/UserCommand.tsx",
                "progress: 412/1284 modules, 38.4 MB in cache, an extremely long line of build output that runs well past the width of any phone screen and past this column too",
                "progress: 688/1284 modules",
                "progress: 964/1284 modules",
                "progress: 1201/1284 modules",
                "rendering chunks (42)...",
                "computing gzip size (18)...",
                "computing gzip size (42)...",
                "built in 1.42s",
            ].join("\n"),
        }),
    },
};
