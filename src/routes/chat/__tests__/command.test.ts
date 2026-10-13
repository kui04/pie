import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@/lib/rpc-protocol";
import { commandRows, slashHint, slashName, bashCommandOf } from "@/routes/chat/composer/command";
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

    it("lets a command that pi registered pass", () => {
        // An extension command, a prompt template and a skill are pi's to take or
        // expand; this side only knows that they are no message of its own.
        expect(slashHint("/review the diff", ["review"])).toBeNull();
    });

    it("refuses a command of pi's terminal UI with where the thing lives here", () => {
        for (const [name, word] of [
            ["model", "button under the message box"],
            ["thinking", "button under the message box"],
            ["session", "list at the top"],
            ["resume", "list at the top"],
        ] as const) {
            expect(slashHint(`/${name}`, [])).toContain(word);
        }

        expect(slashHint("/settings", [])).not.toBeNull();
        expect(slashHint("/hotkeys", [])).not.toBeNull();
    });

    it("refuses a command nothing knows, so that it never becomes a message", () => {
        expect(slashHint("/nope", [])).toBe("/nope is not a command of pie.");
        expect(slashHint("/", [])).toBe("Type a command after the slash.");
        expect(slashHint("hello", [])).toBeNull();
        // The commands of pie itself are not here yet: they must not become a
        // message either.
        for (const name of ["compact", "copy", "name"]) {
            expect(slashHint(`/${name}`, [])).toBe(`/${name} is not a command of pie.`);
        }
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

    it("offers the commands pi registered, in the order pi gave them", () => {
        const rows = commandRows("", commands);

        expect(rows.map((row) => row.name)).toEqual(["review", "fix-test", "deploy"]);
        expect(rows[0]).toEqual({
            id: "pi-review",
            name: "review",
            description: "Review the working tree",
        });
    });

    it("finds a command by the letters of its name, in order", () => {
        expect(commandRows("fix", commands).map((row) => row.name)).toEqual(["fix-test"]);
        expect(commandRows("fx", commands).map((row) => row.name)).toEqual(["fix-test"]);
        // The letters have to come in order, and each of them has to be there.
        expect(commandRows("xft", commands)).toEqual([]);
        expect(commandRows("zzz", commands)).toEqual([]);
        // The commands of pie itself are not in this list yet.
        expect(commandRows("comp", commands)).toEqual([]);
    });

    it("reads a skill by the name of the skill, and by its full name too", () => {
        const skills: SlashCommand[] = [
            slashCommand("foo-bar", "A command with those letters in it", "extension"),
            slashCommand("skill:foo", "Do the foo thing", "skill"),
        ];

        // `foo` is the skill's own name, which is the name a person thinks of; `skil` is
        // only in the `skill:` pi puts in front of it, and finds it as well.
        expect(commandRows("foo", skills).map((row) => row.name)).toEqual(["skill:foo", "foo-bar"]);
        expect(commandRows("skil", skills).map((row) => row.name)).toEqual(["skill:foo"]);
    });
});
