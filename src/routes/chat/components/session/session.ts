/**
 * The rules the session components read a session by: the rows of the list, and the
 * numbers of its usage.
 *
 * It sits beside those components rather than in `lib/`: only `SessionDrawer` and
 * `UsagePopover` read it, and `lib/` holds what more than one area of the app reads.
 *
 * Nothing here reaches Rust or React: Rust answers with what the host holds, and how
 * a person reads it is pie's own rule. Therefore a test holds this without a DOM and
 * without a bridge.
 */

import type { SessionTokens } from "@/lib/protocol";
import { BREATHE_CYCLE } from "@/lib/motion";
import type { SessionSummary } from "@/lib/bridge";

// The rows of the list, from the flat listing that Rust wrote.

/** The sessions of one working directory, in the order Rust gave them. */
export interface SessionGroup {
    /** The directory the sessions of this group started in. */
    cwd: string;
    /** Its sessions, most recently written first. */
    sessions: SessionSummary[];
}

/**
 * The sessions of one directory together, the directory of the newest one first.
 *
 * A session whose header names no directory (`cwd` is empty, which files older
 * than that field of pi leave) is its own group, and sorts last: it has no place
 * to name, so it does not push a directory that has one down the list.
 */
export function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
        const group = groups.get(session.cwd);
        if (group === undefined) groups.set(session.cwd, [session]);
        else group.push(session);
    }
    return [...groups].map(([cwd, sessions]) => ({ cwd, sessions })).sort(byNewestFirst);
}

/**
 * The newest session of the two groups first, and a group with no directory below
 * every group that has one.
 */
function byNewestFirst(left: SessionGroup, right: SessionGroup): number {
    const unnamed = Number(left.cwd === "") - Number(right.cwd === "");
    return unnamed !== 0 ? unnamed : modifiedAt(right) - modifiedAt(left);
}

/** When the newest session of a group was written, as a number; unreadable last. */
function modifiedAt(group: SessionGroup): number {
    const at = Date.parse(group.sessions[0]?.modified ?? "");
    // A comparator may not answer `NaN`: the sort would keep any order at all.
    return Number.isNaN(at) ? -Infinity : at;
}

/**
 * What a row says about a session.
 *
 * The name comes first, then the words that opened the conversation, and a
 * session with neither goes unnamed: the row still carries the time it was last
 * written, and a made-up title would be a fact pie does not have.
 */
export function sessionTitle(session: SessionSummary): string | null {
    const name = session.name?.trim();
    if (name) return name;
    const first = session.firstMessage?.trim().replace(/\s+/g, " ");
    return first ? first : null;
}

/**
 * How long ago a session was last written, in pi's own words: `now`, `5m`, `3h`,
 * `2d`, `4w`, `7mo`, `2y`.
 *
 * `now` is a number, not a date, so a caller that holds the clock can decide when
 * the row is written and a test does not have to wait for one. A stamp that
 * cannot be read is not a time: a row says nothing (`--`, as an unknown reading
 * of the usage does) rather than counting `NaN`.
 */
export function relativeTime(modified: string, now: number): string {
    const at = Date.parse(modified);
    if (Number.isNaN(at)) return "--";
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) return "now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
}

/**
 * Whether a session is one that a search asks for.
 *
 * Everything a row says is searched: the name, the words that opened the
 * conversation, the file it lives in, and the directory it started in — a person
 * looking for the work of one project types the project.
 */
export function matchesSearch(session: SessionSummary, search: string): boolean {
    const needle = search.trim().toLowerCase();
    if (needle === "") return true;
    return [session.name, session.firstMessage, session.cwd, session.path]
        .filter((field): field is string => typeof field === "string")
        .some((field) => field.toLowerCase().includes(needle));
}

/**
 * A short key for the path of a session file, for the id of a row.
 *
 * A path cannot be an id: `/` and `:` are syntax to a selector, and the id would
 * carry the layout of the host into the page. FNV-1a in base 36 answers the same key
 * every time; the path itself goes to the row as `data-path`, for automation.
 */
export function pathKey(path: string): string {
    let hash = 2166136261;
    for (const character of path) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/**
 * How bright the light of a row is at `ms` of its cycle: dim, bright, dim.
 *
 * A cosine, so the turn at each end is smooth and the seam does not show: the value
 * and its speed both come back to where the cycle started.
 */
export function breatheAt(ms: number): number {
    const phase = (ms % BREATHE_CYCLE) / BREATHE_CYCLE;
    return DIM + (1 - DIM) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
}

/** How far the light dims: faint enough to read as a breath, bright enough to see. */
const DIM = 0.35;

// The numbers of a session's usage, as the header and its popover show them.

// The numbers of a session's usage, as the header and its popover show them.

/** A token count, short: `124k`, `1.2k`, `2.5M`. Pi's own footer counts this way. */
export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

/** The share of the context window, or `--` while pi does not know it (pi prints a `?`). */
export function percentText(percent: number | null): string {
    return percent === null ? "--" : `${percent.toFixed(1)}%`;
}

/** What a session cost so far looks like: two decimals, as the design asks. Pi's footer writes three. */
export function costText(cost: number): string {
    return `$${cost.toFixed(2)}`;
}

/**
 * Which colour a reading earns. Pi's own footer warns past 70 and alarms past
 * 90 of the context window, and says nothing of a reading it does not have.
 */
export function usageTone(percent: number | null): "normal" | "warning" | "error" {
    if (percent === null) return "normal";
    if (percent > 90) return "error";
    if (percent > 70) return "warning";
    return "normal";
}

/**
 * The token totals of a session in pi's own marks and order - `↑12k ↓3.4k R180k
 * W9.2k` - each of which only appears once it has a count behind it, as in pi's
 * footer. An empty string is a session that has spent nothing yet.
 *
 * Pi's footer prints one more mark, `CH<n>%`, the cache hit rate of the latest
 * assistant message. This read does not carry it; a caller can count it from the
 * entries, whose assistant messages hold the usage it is built from.
 */
export function tokenBreakdown(tokens: SessionTokens): string {
    const parts: string[] = [];
    if (tokens.input) parts.push(`↑${formatTokens(tokens.input)}`);
    if (tokens.output) parts.push(`↓${formatTokens(tokens.output)}`);
    if (tokens.cacheRead) parts.push(`R${formatTokens(tokens.cacheRead)}`);
    if (tokens.cacheWrite) parts.push(`W${formatTokens(tokens.cacheWrite)}`);
    return parts.join(" ");
}
