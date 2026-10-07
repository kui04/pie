import type { SessionTokens } from "@/lib/protocol";

/**
 * The numbers of a session's usage, as the header and its popover show them.
 */

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
