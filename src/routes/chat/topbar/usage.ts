/**
 * The numbers of a session's usage, as the bar and its popover show them.
 *
 * It sits beside the topbar rather than in `lib/`: the ring, the popover and the bar
 * are the only readers, and `lib/` holds what more than one area of the app reads.
 *
 * Nothing here reaches Rust or React: pi reports a usage, and how a person reads its
 * numbers is pie's own rule (pi counts them in its footer). Therefore a test holds
 * this without a DOM and without a bridge.
 */

import type { SessionStats, SessionTokens, Usage } from "@/lib/rpc-protocol";

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

/**
 * The readings of a session with the response that streams added to them.
 *
 * A read of the usage sees what pi wrote to the session file, and the message of a run
 * is written only when its response is over. The deltas of that response carry its own
 * cumulative usage, so the numbers a reader watches - the share of the window, the
 * tokens, the cost - can follow the response while it arrives. `live` is `null` the
 * rest of the time, and the read stands alone.
 *
 * The context of the running response is the tokens it has spent so far (what pi reads
 * as `totalTokens`): the prompt it was given, plus what it has written since. That is
 * the same reading pi itself trusts over its estimate wherever it has one.
 */
export function withLiveUsage(stats: SessionStats | null, live: Usage | null): SessionStats | null {
    if (stats === null || live === null) return stats;

    const tokens: SessionTokens = {
        input: stats.tokens.input + live.input,
        output: stats.tokens.output + live.output,
        cacheRead: stats.tokens.cacheRead + live.cacheRead,
        cacheWrite: stats.tokens.cacheWrite + live.cacheWrite,
        total: stats.tokens.total + contextTokens(live),
    };
    const window = stats.contextUsage?.contextWindow ?? 0;
    const spent = contextTokens(live);

    return {
        ...stats,
        tokens,
        cost: stats.cost + (live.cost?.total ?? 0),
        contextUsage:
            window > 0 ? { tokens: spent, contextWindow: window, percent: (spent / window) * 100 } : stats.contextUsage,
    };
}

/** The tokens a response spent: pi reads a usage the way `calculateContextTokens` does. */
function contextTokens(usage: Usage): number {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
