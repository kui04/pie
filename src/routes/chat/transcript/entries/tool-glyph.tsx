import {
    BookOpen,
    Bot,
    Braces,
    Brain,
    CircleHelp,
    FilePen,
    FileSearch,
    FileText,
    FolderTree,
    Globe,
    ListChecks,
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
 * The names are pi's own tool names, with the aliases a sibling agent may use beside them, and
 * the choices are OpenChamber's (`parts/toolPresentation.tsx`): a pencil for an edit, a file for
 * a read, braces for a script, a terminal for a command, a globe for a fetch, a brain for a
 * thought. A name nothing here knows gets the wrench, because an unknown tool is still a tool.
 *
 * Size is the caller's: `MarkerIcon` hands every bare svg the 16px the marker keeps.
 */
const GLYPHS: Array<[LucideIcon, string[]]> = [
    [Brain, ["reasoning", "thinking"]],
    [Pencil, ["edit", "patch", "apply_patch", "str_replace"]],
    [FilePen, ["write", "create", "file_write"]],
    [FileText, ["read", "view", "cat", "file_read"]],
    [Braces, ["execute", "codemode"]],
    [Terminal, ["bash", "shell", "cmd", "terminal", "shell_command"]],
    [FolderTree, ["ls", "dir", "list_files"]],
    [Search, ["search", "grep", "find", "ripgrep"]],
    [FileSearch, ["glob"]],
    [Globe, ["fetch", "curl", "wget", "webfetch", "web_search", "ollama_web_search", "ollama_web_fetch"]],
    [Bot, ["subagent", "task", "agent"]],
    [ListChecks, ["todowrite", "todo", "task_list"]],
    [BookOpen, ["skill", "skill_invocation"]],
    [CircleHelp, ["question", "ask_user"]],
    [Plug, ["mcp", "mcp_", "tool_search", "tool_search_tool"]],
];

/** How a tool's name is spelled on its row: a reader's word, not pi's identifier. */
const NAMES: Array<[string, string[]]> = [
    ["Search", ["grep", "find", "glob", "ripgrep", "search"]],
    ["List", ["ls", "dir", "list_files"]],
    ["Bash", ["bash", "shell", "cmd", "terminal", "shell_command"]],
    ["Patch", ["apply_patch", "str_replace"]],
    ["Script", ["execute", "codemode"]],
    ["Task", ["subagent", "task", "agent"]],
];

export function glyphFor(tool: string): ReactNode {
    const name = tool.toLowerCase();
    for (const [Icon, names] of GLYPHS) {
        if (names.includes(name)) return <Icon />;
    }
    // A namespaced tool, `mcp__github__search_code` or `jira_issue`, is a server's tool.
    if (name.includes("_") === false) return <Wrench />;
    for (const [Icon, names] of GLYPHS) {
        if (names.some((known) => name.startsWith(known))) return <Icon />;
    }
    return <Wrench />;
}

/** The word a row's kind is introduced by. */
export function toolLabel(tool: string): string {
    const name = tool.toLowerCase();
    for (const [label, names] of NAMES) {
        if (names.includes(name)) return label;
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
}
