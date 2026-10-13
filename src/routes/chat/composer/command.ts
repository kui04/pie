/**
 * The two lines the composer reads as more than a prompt - a `/` command and a
 * `!` shell run - and the rows the command menu offers for a `/` name.
 *
 * A slash command never reaches the model as a message. Pi's own terminal UI
 * answers its built-in commands before a prompt becomes a message; the RPC does
 * not — `session.prompt` takes an extension command and expands a template or a
 * skill, and everything else of that shape is a message like any other. Therefore
 * this side keeps the list: it sends the commands that pi registered, and refuses
 * the rest with a word about where the thing lives in this app.
 */

import type { SlashCommand } from "@/lib/rpc-protocol";
import { fuzzyFilter } from "@/lib/fuzzy";

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

/** The name of a slash line without its slash, `""` for a bare slash, or `null`. */
export function slashName(text: string): string | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return null;
    return trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
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

/**
 * Why the composer must refuse a line, or `null` when the line may pass.
 *
 * A command pi registered passes: pi takes it or expands it. Every other slash
 * line is refused, because a prompt would carry it to the model as words — the
 * commands of pi's terminal UI among them, which get the word for where the
 * thing lives in this app.
 */
export function slashHint(text: string, piCommands: readonly string[]): string | null {
    const name = slashName(text);
    if (name === null) return null;
    if (name === "") return "Type a command after the slash.";
    if (piCommands.includes(name)) return null;
    return ELSEWHERE[name] ?? `/${name} is not a command of pie.`;
}

/** One row of the command menu: a command, and what it says about itself. */
export interface CommandRow {
    /** Unique in the list, and the value the menu highlights. */
    id: string;
    /** The name of the command, without its slash: every row reads `/name`. */
    name: string;
    /** What pi wrote about the command; `null` when pi wrote nothing. */
    description: string | null;
}

/**
 * The rows the command menu shows for the typed name.
 *
 * The rows are the commands pi registered over the RPC, in the order pi reported
 * them. Every row is the same shape: the name, and what the command says about
 * itself. The design keeps this one list: an extension command, a prompt template
 * and a skill are told apart by what they say, not by a heading over them.
 *
 * The commands of pie itself are not here yet. When they land, they follow the
 * same shape as these.
 *
 * The name is matched the way pi's own editor matches one
 * (`packages/tui/src/autocomplete.ts` of the pinned release): the fuzzy filter of its
 * selectors over the name of the command, and a skill first by its bare name, so that
 * `foo` ranks `/skill:foo` over any command that merely holds those letters. An empty
 * name keeps every row in pi's order, which is what a bare `/` shows.
 */
export function commandRows(name: string, piCommands: readonly SlashCommand[]): CommandRow[] {
    const rows: CommandRow[] = piCommands.map((command) => ({
        id: `pi-${command.name}`,
        name: command.name,
        description: command.description ?? null,
    }));

    const bare = fuzzyFilter(rows, name, (row) => bareName(row.name));
    const found = new Set(bare.map((row) => row.id));
    const full = fuzzyFilter(
        rows.filter((row) => row.name.startsWith(SKILL_PREFIX) && !found.has(row.id)),
        name,
        (row) => row.name,
    );
    return [...bare, ...full];
}

/** What pi calls a skill command, before the name of the skill itself. */
const SKILL_PREFIX = "skill:";

/** The name a command is matched by, which for a skill is the skill's own. */
function bareName(name: string): string {
    return name.startsWith(SKILL_PREFIX) ? name.slice(SKILL_PREFIX.length) : name;
}
