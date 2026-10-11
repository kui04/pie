/**
 * Entries to build a transcript with, for tests and stories.
 *
 * Nothing under `src/routes` imports this file: the app renders what pi wrote,
 * and this builds what pi would have written. It exists so a story and a test
 * can show the same fixture, and so a field that pi renamed fails to compile in
 * one place instead of two.
 */

import type {
    AgentMessage,
    AssistantMessage,
    BashExecutionMessage,
    Model,
    SessionEntry,
    SessionState,
    SessionStats,
    SlashCommand,
    SlashCommandSource,
    ToolCall,
    ToolResultMessage,
    Usage,
} from "@/lib/rpc-protocol";
import type { SessionSummary } from "@/lib/bridge";
import type { TranscriptEntries } from "@/lib/transcript";

/** When every fixture happened. The clock is not part of what is under test. */
export const AT = "2026-01-01T00:00:00.000Z";
const MILLIS = Date.parse(AT);

/** An entry before it has a place in a chain: everything but its links. */
type Unlinked<E> = E extends { id: string; parentId: string | null } ? Omit<E, "id" | "parentId"> : never;

/** An entry of a chain, with its links put in: `e1`, `e2`, ... in order. */
export function chain(...entries: Unlinked<SessionEntry>[]): SessionEntry[] {
    return entries.map((entry, index) => ({
        ...entry,
        id: `e${index + 1}`,
        parentId: index === 0 ? null : `e${index}`,
    }));
}

/** The entries of a fixture chain, in the shape the fold reads. */
export function storeOf(entries: SessionEntry[]): TranscriptEntries {
    return { entries: new Map(entries.map((entry) => [entry.id, entry])), order: entries.map((entry) => entry.id) };
}

export const usage = (overrides: Partial<Usage> = {}): Usage => ({
    input: 1000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1200,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    ...overrides,
});

/** What a session reports about itself, as the header's popover reads it. */
export const sessionStats = (overrides: Partial<SessionStats> = {}): SessionStats => ({
    sessionId: "0193f0c4-0000-7000-8000-000000000000",
    sessionFile: "/home/kui/.pi/agent/sessions/pie.jsonl",
    userMessages: 4,
    assistantMessages: 8,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 12,
    tokens: { input: 12000, output: 3400, cacheRead: 184000, cacheWrite: 9200, total: 208600 },
    cost: 0.45,
    contextUsage: { tokens: 23349, contextWindow: 512000, percent: 4.5603515625 },
    ...overrides,
});

/** The state of a session, as `get_state` reports it. */
export const sessionState = (overrides: Partial<SessionState> = {}): SessionState => ({
    model: model(),
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionFile: "/home/kui/.pi/agent/sessions/pie.jsonl",
    sessionId: "0193f0c4-0000-7000-8000-000000000000",
    sessionName: "Fix the parser",
    autoCompactionEnabled: false,
    messageCount: 12,
    pendingMessageCount: 0,
    ...overrides,
});

/** Which row a fixture is, so that two of them never answer to one id. */
let rows = 0;

/** A row of the session list, as the scan of the host reports it. */
export function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    rows += 1;
    const cwd = overrides.cwd ?? "/home/kui/Projects/pie";
    return {
        path: `/home/kui/.pi/agent/sessions/--home-kui-Projects-pie--/2026-01-01T00-00-00-000Z_${rows}.jsonl`,
        id: `0193f0c4-0000-7000-8000-${String(rows).padStart(12, "0")}`,
        cwd,
        name: "Fix the parser",
        created: AT,
        modified: AT,
        firstMessage: "Make the parser skip empty lines, and run the tests.",
        ...overrides,
    };
}

/** One model of `get_available_models`, as pi reports it. */
export function model(overrides: Partial<Model> = {}): Model {
    return {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 64_000,
        ...overrides,
    };
}

/** One command of `get_commands`, as pi reports it. */
export function slashCommand(name: string, description: string, source: SlashCommandSource): SlashCommand {
    return {
        name,
        description,
        source,
        sourceInfo: {
            path: `/home/pie/.pi/${source}s/${name}.md`,
            source: source === "extension" ? "npm:pi-review" : source === "prompt" ? "top-level" : "~/work/pie",
            scope: "user",
            origin: source === "extension" ? "package" : "top-level",
        },
    };
}

export function user(text: string, timestamp = MILLIS): AgentMessage {
    return { role: "user", content: text, timestamp };
}

export function assistant(
    content: AssistantMessage["content"],
    overrides: Partial<AssistantMessage> = {},
): { role: "assistant" } & AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: usage(),
        stopReason: "stop",
        timestamp: MILLIS,
        ...overrides,
    };
}

export function bashExecution(
    command: string,
    output: string,
    overrides: Partial<BashExecutionMessage> = {},
): AgentMessage {
    return {
        role: "bashExecution",
        command,
        output,
        exitCode: undefined,
        cancelled: false,
        truncated: false,
        timestamp: MILLIS,
        ...overrides,
    };
}

export function toolCall(id: string, name: string, args: ToolCall["arguments"]): ToolCall {
    return { type: "toolCall", id, name, arguments: args };
}

export function toolResult(
    toolCallId: string,
    toolName: string,
    text: string,
    overrides: Partial<ToolResultMessage> = {},
): { role: "toolResult" } & ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: MILLIS,
        ...overrides,
    };
}

export const text = (value: string) => ({ type: "text" as const, text: value });
export const thinking = (value: string) => ({ type: "thinking" as const, thinking: value, redacted: false });
export const image = (mimeType = "image/png") => ({ type: "image" as const, data: "aGk=", mimeType });

export const messageEntry = (message: AgentMessage): Unlinked<SessionEntry> => ({
    type: "message",
    timestamp: AT,
    message,
});

export const modelChange = (modelId = "claude-sonnet-4-5"): Unlinked<SessionEntry> => ({
    type: "model_change",
    timestamp: AT,
    provider: "anthropic",
    modelId,
});

export const thinkingLevelChange = (thinkingLevel = "medium"): Unlinked<SessionEntry> => ({
    type: "thinking_level_change",
    timestamp: AT,
    thinkingLevel,
});

export const usageEntry = (): Unlinked<SessionEntry> => ({
    type: "usage",
    timestamp: AT,
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: usage(),
});

export const sessionInfo = (name: string | undefined = undefined): Unlinked<SessionEntry> => ({
    type: "session_info",
    timestamp: AT,
    name,
});

/**
 * A session of a few turns, with the shapes a transcript has to survive: a
 * thought, a diff, a long output, a read that starts mid-file, a call that
 * failed, a command the reader ran themselves, and a custom message of an
 * extension.
 */
export function sampleTranscript(): SessionEntry[] {
    return chain(...turns());
}

/** The same session after a compaction, with the latest turns kept whole. */
export function compactedTranscript(): SessionEntry[] {
    return chain(...turns(), {
        type: "compaction",
        timestamp: AT,
        summary:
            "The parser was changed to filter empty lines after the split, and the tests for the parser were run and pass.",
        firstKeptEntryId: "e10",
        tokensBefore: 18432,
    });
}

function turns(): Unlinked<SessionEntry>[] {
    const diff = [
        "  12 export function parse(text: string) {",
        '- 13     return text.split("\\n");',
        '+ 13     return text.split("\\n").filter(Boolean);',
        "  14 }",
    ].join("\n");
    const output = Array.from({ length: 12 }, (_, index) => `test ${index + 1} ... ok`).join("\n");

    return [
        modelChange(),
        thinkingLevelChange(),
        sessionInfo("parser work"),
        messageEntry(user("Make the parser skip empty lines, and run the tests.")),
        messageEntry(
            assistant(
                [
                    thinking("The split leaves empty trailing entries. Filtering after the split is enough."),
                    text("Filtering the lines after the split does it."),
                    toolCall("c1", "edit", {
                        path: "/home/dev/project/parse.ts",
                        edits: [{ oldText: "a", newText: "b" }],
                    }),
                ],
                { stopReason: "toolUse" },
            ),
        ),
        messageEntry(toolResult("c1", "edit", "the file was written", { details: { diff } })),
        messageEntry(
            assistant([text("Now the tests."), toolCall("c2", "bash", { command: "pnpm test" })], {
                stopReason: "toolUse",
            }),
        ),
        messageEntry(toolResult("c2", "bash", output)),
        messageEntry(
            assistant([toolCall("c3", "read", { path: "/home/dev/project/notes.md", offset: 40 })], {
                stopReason: "toolUse",
            }),
        ),
        messageEntry(toolResult("c3", "read", "the notes\ncontinue here\nand here", { toolName: "read" })),
        messageEntry(assistant([toolCall("c4", "bash", { command: "cat /nowhere" })], { stopReason: "toolUse" })),
        messageEntry(toolResult("c4", "bash", "cat: /nowhere: No such file or directory", { isError: true })),
        messageEntry(bashExecution("git status", "On branch main\nnothing to commit, working tree clean")),
        {
            type: "custom_message",
            timestamp: AT,
            customType: "skill",
            content: [
                { type: "text", text: "The skill `release-notes` ran." },
                { type: "text", text: "It wrote three entries into `CHANGELOG.md`." },
            ],
            display: true,
        },
        messageEntry(user("Good. What does the changelog say?")),
        messageEntry(assistant([text("Three entries, one for each fix.")], { stopReason: "stop" })),
    ];
}
