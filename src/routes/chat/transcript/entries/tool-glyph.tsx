import {
    Archive,
    Braces,
    Brain,
    FilePen,
    FileSearch,
    FileText,
    FolderTree,
    GitBranch,
    Pencil,
    Plug,
    Puzzle,
    Search,
    Sparkles,
    Terminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { humanize } from "@/lib/text";

/**
 * The glyph of a call's kind, in one place: what a row did, at a glance.
 *
 * The names are pi's own (`ToolName` in pi's `core/tools/index.ts`), plus the `codemode` and
 * `tool_search` extensions and the `mcp__server__tool` shape. A name nothing here knows gets
 * the wrench, or the plug when it carries the `__` of a namespaced tool.
 *
 * Size is the caller's: `MarkerIcon` hands every bare svg the 16px the marker keeps.
 */
const GLYPHS: Array<[LucideIcon, string[]]> = [
    [Pencil, ["edit"]],
    [FilePen, ["write"]],
    [FileText, ["read"]],
    [Braces, ["codemode"]],
    [Terminal, ["bash", "powershell"]],
    [FolderTree, ["ls"]],
    [Search, ["grep"]],
    [FileSearch, ["find"]],
    [Plug, ["tool_search"]],
];

export function glyphFor(tool: string): ReactNode {
    const name = tool.toLowerCase();
    for (const [Icon, names] of GLYPHS) {
        if (names.includes(name)) return <Icon />;
    }
    if (name.includes("__")) return <Plug />;
    return <Wrench />;
}

/** A thought is no call, so it keeps its own glyph instead of sharing the map. */
export function thoughtGlyph(): ReactNode {
    return <Brain />;
}

/** What a compaction folded away: the old context, archived. */
export function compactionGlyph(): ReactNode {
    return <Archive />;
}

/** The summary of a branch the session left. */
export function branchGlyph(): ReactNode {
    return <GitBranch />;
}

/** What a skill run left behind. */
export function skillGlyph(): ReactNode {
    return <Sparkles />;
}

/** A custom message of an extension: another piece it plugged in. */
export function customGlyph(): ReactNode {
    return <Puzzle />;
}

/** The word a row's kind is introduced by; a namespaced tool reads `server / tool`. */
export function toolLabel(tool: string): string {
    const name = tool.toLowerCase();
    // Humanize would spell it `Powershell`.
    if (name === "powershell") return "PowerShell";
    if (name.includes("__")) {
        const parts = name.split("__");
        // The plug already marks an MCP tool, so its `mcp` lead would only repeat it.
        const shown = parts[0] === "mcp" ? parts.slice(1) : parts;
        return shown
            .map(humanize)
            .filter((part) => part !== "")
            .join(" / ");
    }
    return humanize(name);
}
