/**
 * What a line that starts with `/` means to the composer, and what the command
 * menu offers.
 *
 * A slash command never reaches the model as a message. Pi's own terminal UI
 * answers its built-in commands before a prompt becomes a message; the RPC does
 * not — `session.prompt` takes an extension command and expands a template or a
 * skill, and everything else of that shape is a message like any other. Therefore
 * this side keeps the list: it answers the commands of pie itself, sends the
 * commands that pi registered, and refuses the rest with a word about where the
 * thing lives in this app.
 */

import type { SlashCommand } from "@/lib/protocol";

/** The commands of pie itself, answered without pi. */
export type OwnCommand = "compact" | "copy" | "name";

/**
 * Where a command of pi's terminal UI lives in pie, or why it lives nowhere yet.
 *
 * Pi's own built-ins are answered by its terminal UI, not by the protocol: sent
 * through a prompt they would become words for the model, which is the one thing
 * this list exists to prevent.
 */
const ELSEWHERE: Record<string, string> = {
    model: "Choose the model with its button under the message box.",
    thinking: "Choose the thinking level with its button under the message box.",
    session: "This session is in the list at the top of the screen.",
    resume: "Switch the conversation in the list at the top of the screen.",
    settings: "pie has no settings screen yet.",
    hotkeys: "pie has no list of keyboard shortcuts yet.",
};

/** What a line means to the composer, or `null` when the line is no command. */
export type SlashIntent =
    /** Pie answers it itself. */
    | { kind: "own"; command: OwnCommand; argument: string }
    /** Pi registered it: the text goes to pi, which takes it or expands it. */
    | { kind: "pi" }
    /** Nothing here knows it, and it must not become a message. */
    | { kind: "hint"; message: string };

/** The name of a slash line without its slash, `""` for a bare slash, or `null`. */
export function slashName(text: string): string | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return null;
    return trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
}

/** The rest of a slash line after its first word. */
export function slashArgument(text: string): string {
    const trimmed = text.trim();
    const firstSpace = trimmed.search(/\s/);
    return firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
}

/**
 * A line in bash mode: the command after `!`, and whether its result stays out of
 * the context of the model (the `!!` form). `null` when the line is no bash command.
 */
export function bashCommandOf(text: string): { command: string; excludeFromContext: boolean } | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("!")) return null;
    const excludeFromContext = trimmed.startsWith("!!");
    return { command: trimmed.slice(excludeFromContext ? 2 : 1).trim(), excludeFromContext };
}

/** How the composer takes a line, or `null` when the line is no command. */
export function slashIntent(text: string, piCommands: readonly string[]): SlashIntent | null {
    const name = slashName(text);
    if (name === null) return null;
    if (name === "") return { kind: "hint", message: "Type a command after the slash." };
    if (name === "compact" || name === "copy" || name === "name") {
        return { kind: "own", command: name, argument: slashArgument(text) };
    }
    if (piCommands.includes(name)) return { kind: "pi" };
    const elsewhere = ELSEWHERE[name];
    if (elsewhere !== undefined) return { kind: "hint", message: elsewhere };
    return { kind: "hint", message: `/${name} is not a command of pie.` };
}

/** What choosing a row of the command menu does. */
export type CommandAction =
    /** Puts `/name ` in the input, for the command of pi to take when it is sent. */
    | { kind: "complete"; name: string }
    | { kind: "compact" }
    | { kind: "copy" }
    | { kind: "toggle-compaction"; enabled: boolean };

/** One row of the command menu. */
export interface CommandRow {
    /** Unique in the list, and the value the menu highlights. */
    id: string;
    label: string;
    /** What pi wrote about the command, or what an action says about itself. */
    description: string | null;
    action: CommandAction;
}

/**
 * The rows the command menu shows for the typed name.
 *
 * The commands of pi come first, in the order pi reported them; the actions of pie
 * - the ones this client answers itself, and the only ones whose state it can show
 * (the compaction switch) - follow. The design keeps this one list: an extension
 * command, a prompt template and a skill are told apart by what they say, not by a
 * heading over them.
 *
 * The typed name is a prefix of a row, which is what the person is still writing:
 * the menu closes once the name is chosen.
 */
export function commandRows(name: string, piCommands: readonly SlashCommand[], autoCompaction: boolean): CommandRow[] {
    const typed = name.toLowerCase();
    const matches = (candidate: string) => candidate.toLowerCase().startsWith(typed);
    const rows: CommandRow[] = [];

    for (const command of piCommands) {
        if (!matches(command.name)) continue;
        rows.push({
            id: `pi-${command.name}`,
            label: `/${command.name}`,
            description: command.description ?? null,
            action: { kind: "complete", name: command.name },
        });
    }

    if (matches("compact")) {
        rows.push({ id: "pie-compact", label: "Compact now", description: null, action: { kind: "compact" } });
    }
    if (matches("copy")) {
        rows.push({ id: "pie-copy", label: "Copy last answer", description: null, action: { kind: "copy" } });
    }
    if (matches("compaction")) {
        rows.push({
            id: "pie-auto-compaction",
            label: `Automatic compaction: ${autoCompaction ? "on" : "off"}`,
            description: null,
            action: { kind: "toggle-compaction", enabled: !autoCompaction },
        });
    }
    return rows;
}
