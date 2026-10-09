import { describe, expect, it } from "vitest";
import type { ToolResultMessage } from "@/lib/protocol";
import { presentCall, presentExecution, presentRunningExecution } from "@/routes/chat/components/toolPresentation";

const result = (text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
    ...overrides,
});

describe("how a tool reads on the card", () => {
    it("leads a call with what it aimed at, per tool", () => {
        expect(presentCall("edit", { path: "/a.ts" }, result("ok")).detail).toBe("/a.ts");
        expect(presentCall("read", { path: "/a.ts", offset: 12 }, result("ok")).body).toMatchObject({ kind: "file" });
        expect(presentCall("grep", { pattern: "foo", path: "/src", glob: "*.ts", limit: 5 }, result("ok")).detail).toBe(
            "/foo/ in /src (*.ts) limit 5",
        );
        expect(presentCall("bash", { command: "make", timeout: 30 }, result("ok")).detail).toBe("make (timeout 30s)");
    });

    it("keeps a running call running, whatever it streamed so far", () => {
        // What a call streamed is not an answer: the status of the card says the tool
        // works, and the body is what arrived until now.
        const streaming = presentCall("bash", { command: "pnpm test" }, result("half of the output"), false, true);

        expect(streaming.status).toBe("running");
        expect(streaming.body).toMatchObject({ kind: "log", lines: ["half of the output"] });
    });

    it("falls back to the arguments for a tool it does not know", () => {
        const unknown = presentCall("web_search", { query: "tauri", count: 5 }, result("ok"));

        expect(unknown.detail).toBe('query="tauri" count=5');
        expect(unknown.body).toMatchObject({ kind: "log" });
    });

    it("says where a truncated output went, and what a run of the reader cost", () => {
        const truncated = presentCall(
            "bash",
            { command: "cat big" },
            result("end", {
                details: {
                    truncation: { truncated: true, outputLines: 200, totalLines: 9000 },
                    fullOutputPath: "/tmp/o",
                },
            }),
        );

        expect(truncated.notes).toEqual([
            { text: "Truncated: 200 of 9000 lines", tone: "warning" },
            { text: "Full output: /tmp/o", tone: "muted" },
        ]);

        const failedRun = presentExecution({
            command: "false",
            output: "",
            cancelled: false,
            truncated: false,
            exitCode: 1,
            timestamp: 0,
        });

        expect(failedRun.title).toBe("$");
        expect(failedRun.tone).toBe("user-run");
        expect(failedRun.notes).toEqual([{ text: "(exit 1)", tone: "error" }]);
    });

    it("shows a command that still runs as running, with what it printed so far", () => {
        const running = presentRunningExecution({ command: "sleep 5", output: "one\ntwo\n" });

        expect(running).toMatchObject({
            title: "$",
            detail: "sleep 5",
            tone: "user-run",
            status: "running",
            body: { kind: "log", lines: ["one", "two"] },
        });
        expect(running.notes).toEqual([]);
    });
});
