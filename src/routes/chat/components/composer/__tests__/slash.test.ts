import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@/lib/rpc-protocol";
import {
    commandRows,
    slashArgument,
    slashIntent,
    slashName,
    bashCommandOf,
} from "@/routes/chat/components/composer/slash";
import { slashCommand } from "@/preview/fixtures";

describe("what a slash line means", () => {
    it("takes the name of a command, and nothing of the rest", () => {
        expect(slashName("/compact be terse")).toBe("compact");
        expect(slashName("  /name")).toBe("name");
        // A bare slash is a command with no name yet.
        expect(slashName("/")).toBe("");
        expect(slashName("hello")).toBeNull();
        expect(slashName("!ls")).toBeNull();
    });

    it("takes the argument of a command as what follows its name", () => {
        expect(slashArgument("/compact be terse")).toBe("be terse");
        expect(slashArgument("/copy")).toBe("");
        expect(slashArgument("/name   my session  ")).toBe("my session");
    });

    it("answers the commands of pie itself, with their argument", () => {
        expect(slashIntent("/compact be terse", [])).toEqual({
            kind: "own",
            command: "compact",
            argument: "be terse",
        });
        expect(slashIntent("/copy", [])).toEqual({ kind: "own", command: "copy", argument: "" });
        expect(slashIntent("/name work", [])).toEqual({ kind: "own", command: "name", argument: "work" });
    });

    it("sends a command that pi registered", () => {
        // An extension command, a prompt template and a skill are pi's to take or
        // expand; this side only knows that they are no message of its own.
        expect(slashIntent("/review the diff", ["review"])).toEqual({ kind: "pi" });
    });

    it("refuses a command of pi's terminal UI with where the thing lives here", () => {
        for (const [name, word] of [
            ["model", "button under the message box"],
            ["thinking", "button under the message box"],
            ["session", "list at the top"],
            ["resume", "list at the top"],
        ] as const) {
            const intent = slashIntent(`/${name}`, []);
            expect(intent).toMatchObject({ kind: "hint" });
            if (intent?.kind === "hint") expect(intent.message).toContain(word);
        }

        expect(slashIntent("/settings", [])).toMatchObject({ kind: "hint" });
        expect(slashIntent("/hotkeys", [])).toMatchObject({ kind: "hint" });
    });

    it("refuses a command nothing knows, so that it never becomes a message", () => {
        expect(slashIntent("/nope", [])).toEqual({
            kind: "hint",
            message: "/nope is not a command of pie.",
        });
        expect(slashIntent("/", [])).toEqual({
            kind: "hint",
            message: "Type a command after the slash.",
        });
        expect(slashIntent("hello", [])).toBeNull();
    });
});

describe("a line in bash mode", () => {
    it("takes the command after the mark, and whether the context is left alone", () => {
        expect(bashCommandOf("!ls -la")).toEqual({ command: "ls -la", excludeFromContext: false });
        expect(bashCommandOf("  !!make test")).toEqual({ command: "make test", excludeFromContext: true });
        expect(bashCommandOf("!")).toEqual({ command: "", excludeFromContext: false });
        expect(bashCommandOf("hi!")).toBeNull();
        expect(bashCommandOf("/copy")).toBeNull();
    });
});

describe("the rows of the command menu", () => {
    const commands: SlashCommand[] = [
        slashCommand("review", "Review the working tree", "extension"),
        slashCommand("fix-test", "Fix a failing test", "prompt"),
        slashCommand("deploy", "Deploy the app", "skill"),
    ];

    it("offers the commands of pi first, then the actions of pie", () => {
        const rows = commandRows("", commands, false);

        expect(rows.map((row) => row.label)).toEqual([
            "/review",
            "/fix-test",
            "/deploy",
            "Compact now",
            "Copy last answer",
            "Automatic compaction: off",
        ]);
        expect(rows.find((row) => row.label === "/review")?.description).toBe("Review the working tree");
        expect(rows[rows.length - 1]?.action).toEqual({ kind: "toggle-compaction", enabled: true });
        // The switch says what it will do: the row carries the state it is in now.
        expect(commandRows("", [], true).find((row) => row.id === "pie-auto-compaction")?.action).toEqual({
            kind: "toggle-compaction",
            enabled: false,
        });
    });

    it("keeps the rows whose name starts with what was typed", () => {
        expect(commandRows("comp", commands, false).map((row) => row.label)).toEqual([
            "Compact now",
            "Automatic compaction: off",
        ]);
        expect(commandRows("rev", commands, false).map((row) => row.label)).toEqual(["/review"]);
        expect(commandRows("zzz", commands, false)).toEqual([]);
    });
});
