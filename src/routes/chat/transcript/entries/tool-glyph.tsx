import {
    Braces,
    Brain,
    FilePen,
    FileSearch,
    FileText,
    FolderTree,
    Pencil,
    Plug,
    Search,
    Terminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

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

function humanize(value: string): string {
    const words = value
        .toLowerCase()
        .split(/[_-]+/)
        .filter((word) => word !== "");
    if (words.length === 0) return value;
    return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
