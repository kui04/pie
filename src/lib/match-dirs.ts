import { basename, dirname, isAbsolute, join, normalize } from "pathe";
import type { DirEntry } from "@/lib/bridge";

/** How many candidates the picker shows at most. */
export const MAX_CANDIDATES = 50;

export interface ParentSplit {
    /** The level to list: the text through the last separator, or `null` for home. */
    parent: string | null;
    /** The name to match: the text after the last separator. */
    stub: string;
}

/**
 * Splits typed text into the level to list and the name to match.
 *
 * `/home/kui` lists `/home` and matches `kui`. Text ending in a separator
 * lists that folder with no match. Text with no separator lists home and
 * matches the whole text. An empty parent after the split is home as well.
 */
export function splitParent(text: string): ParentSplit {
    const trimmed = text.trim();
    if (trimmed === "") return { parent: null, stub: "" };
    const hasSlash = trimmed.includes("/") || trimmed.includes("\\");
    if (!hasSlash) return { parent: null, stub: trimmed };

    const normalized = normalize(trimmed);
    const endsWithSlash = /[/\\]$/.test(trimmed);
    if (endsWithSlash) {
        return { parent: trimPath(normalized), stub: "" };
    }
    const dir = dirname(normalized);
    const base = basename(normalized);
    return {
        parent: dir === "." ? null : dir,
        stub: base,
    };
}

/**
 * The parent of a level: the text through the separator before its last part.
 *
 * `/home/kui` gives `/home`, `/a` gives `/`, `/` stays `/`, and home stays
 * home. A drive keeps its own spelling (`C:\a` gives `C:\`).
 */
export function parentOf(level: string | null): string | null {
    if (level === null || !isAbsolute(level)) return null;
    const norm = normalize(level);
    const dir = dirname(norm);
    if (level.includes("\\") && !level.includes("/")) {
        return dir.replace(/\//g, "\\");
    }
    return dir;
}

/**
 * Whether the text names a path the host can read from its root: POSIX, Windows,
 * or a UNC share.
 */
export function isAbsolutePath(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith("~")) return false;
    return isAbsolute(trimmed);
}

/** The text with a `~` at its start replaced by the home of the host, when it is known. */
export function expandTilde(text: string, home: string | null): string {
    if (home === null || home === "") return text;
    if (text === "~") return home;
    if (text.startsWith("~/") || text.startsWith("~\\")) return home + text.slice(1);
    return text;
}

/**
 * The text without the separators at its end; a root keeps its own, so a root
 * stays a root and an emptied text stays empty.
 */
export function trimPath(text: string): string {
    const trimmed = text.trim();
    if (trimmed === "") return "";
    const norm = normalize(trimmed);
    const isWindowsSlash = trimmed.includes("\\") && !trimmed.includes("/");
    if (norm === "/" || /^[A-Za-z]:\/$/.test(norm)) {
        return isWindowsSlash ? norm.replace(/\//g, "\\") : norm;
    }
    const stripped = norm.replace(/\/+$/, "");
    return isWindowsSlash ? stripped.replace(/\//g, "\\") : stripped;
}

/** The text that makes a level show its own children: the path with a separator at its end. */
export function drillPath(text: string): string {
    const trimmed = text.trim();
    if (trimmed === "/" || trimmed.endsWith("/") || trimmed.endsWith("\\")) return trimmed;
    return `${trimmed}/`;
}

/**
 * Splits field text into the level to list and the name to match.
 *
 * Empty text, tilde, and the home path list the home with no match.
 * Relative paths resolve against the home directory.
 */
export function querySplit(text: string, home: string | null): ParentSplit {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === "~") return { parent: null, stub: "" };
    const expanded = expandTilde(trimmed, home);
    if (home !== null && home !== "" && trimPath(expanded) === trimPath(home)) {
        return { parent: null, stub: "" };
    }
    if (home === null || home === "") {
        if (!isAbsolutePath(expanded)) return { parent: null, stub: trimPath(expanded) };
        return splitParent(expanded);
    }
    const base = trimPath(home);
    const joined = isAbsolutePath(expanded) ? expanded : join(base, expanded);
    const resolved = /[/\\]$/.test(expanded) && !joined.endsWith("/") ? `${joined}/` : joined;
    const split = splitParent(resolved);
    if (split.parent !== null && trimPath(split.parent) === base) {
        return { parent: null, stub: split.stub };
    }
    return split;
}

/**
 * The level above the one a field text names, for the up row.
 *
 * `null` while the text is empty, while it names no path, and at the root,
 * whose parent is itself; otherwise the parent of the level in view, so the row
 * climbs out of it.
 */
export function climbFrom(text: string, home: string | null): string | null {
    const trimmed = text.trim();
    if (trimmed === "" || !isAbsolutePath(expandTilde(trimmed, home))) return null;
    const level = querySplit(trimmed, home).parent ?? home;
    if (level === null) return null;
    const parent = parentOf(level);
    return parent === level ? null : parent;
}

/** The path as a person reads it: the normalized absolute path. */
export function displayPath(path: string): string {
    const trimmed = path.trim();
    if (trimmed === "") return "";
    return normalize(trimmed);
}

export interface DisplayParts {
    /** The directories above the name, with their separator; `""` for a name alone. */
    head: string;
    /** The name itself. */
    leaf: string;
}

/** The shown path split where the name begins. */
export function displayParts(path: string): DisplayParts {
    const shown = displayPath(path);
    const slash = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
    if (slash === -1) return { head: "", leaf: shown };
    return { head: shown.slice(0, slash + 1), leaf: shown.slice(slash + 1) };
}

/**
 * The folders of one level whose names fit a stub, prefix first.
 *
 * Both sides ignore case. Files never match: candidates are what the picker
 * can enter. An empty stub fits every folder of the level.
 */
export function matchDirs(rows: readonly DirEntry[], stub: string): DirEntry[] {
    const folders = rows.filter((row) => row.isDir);
    const needle = stub.toLowerCase();
    if (needle === "") return folders.slice(0, MAX_CANDIDATES);
    const prefix: DirEntry[] = [];
    const held: DirEntry[] = [];
    for (const row of folders) {
        const name = row.name.toLowerCase();
        if (name.startsWith(needle)) prefix.push(row);
        else if (name.includes(needle)) held.push(row);
    }
    return [...prefix, ...held].slice(0, MAX_CANDIDATES);
}
