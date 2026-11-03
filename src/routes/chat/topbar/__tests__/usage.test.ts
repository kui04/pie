import { describe, expect, it } from "vitest";
import {
    costText,
    formatTokens,
    percentText,
    tokenBreakdown,
    usageTone,
    withLiveUsage,
} from "@/routes/chat/topbar/usage";
import { sessionStats, usage } from "@/preview/fixtures";

describe("formatTokens", () => {
    it("counts the way pi's footer counts", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(999)).toBe("999");
        expect(formatTokens(1000)).toBe("1.0k");
        expect(formatTokens(9999)).toBe("10.0k");
        expect(formatTokens(10000)).toBe("10k");
        expect(formatTokens(124000)).toBe("124k");
        expect(formatTokens(1000000)).toBe("1.0M");
        expect(formatTokens(2500000)).toBe("2.5M");
    });
});

describe("percentText", () => {
    it("keeps one decimal, and says nothing when pi does not know", () => {
        expect(percentText(4.5603515625)).toBe("4.6%");
        expect(percentText(0)).toBe("0.0%");
        expect(percentText(103.25)).toBe("103.3%");
        expect(percentText(null)).toBe("--");
    });
});

describe("costText", () => {
    it("reads as money", () => {
        expect(costText(0)).toBe("$0.00");
        expect(costText(0.45)).toBe("$0.45");
        expect(costText(12.345)).toBe("$12.35");
    });
});

describe("usageTone", () => {
    it("warns past 70 and alarms past 90, as pi's footer does", () => {
        expect(usageTone(0)).toBe("normal");
        expect(usageTone(70)).toBe("normal");
        expect(usageTone(70.1)).toBe("warning");
        expect(usageTone(90)).toBe("warning");
        expect(usageTone(90.1)).toBe("error");
        expect(usageTone(100)).toBe("error");
    });

    it("keeps the plain colour for a reading that is not there", () => {
        expect(usageTone(null)).toBe("normal");
    });
});

describe("tokenBreakdown", () => {
    it("marks each total the way pi's footer marks it", () => {
        expect(tokenBreakdown({ input: 12000, output: 3400, cacheRead: 184000, cacheWrite: 9200, total: 208600 })).toBe(
            "↑12k ↓3.4k R184k W9.2k",
        );
    });

    it("leaves out a total with nothing behind it", () => {
        expect(tokenBreakdown({ input: 500, output: 0, cacheRead: 0, cacheWrite: 0, total: 500 })).toBe("↑500");
        expect(tokenBreakdown({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toBe("");
    });
});

describe("the readings of a session while a response streams", () => {
    const stats = sessionStats();

    it("stands alone when no response streams", () => {
        expect(withLiveUsage(stats, null)).toBe(stats);
        expect(withLiveUsage(null, null)).toBeNull();
    });

    it("adds the tokens and the cost of the streaming response", () => {
        const live = usage({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 100, totalTokens: 6300 });

        const read = withLiveUsage(stats, live)!;

        expect(read.tokens).toEqual({
            input: 13000,
            output: 3600,
            cacheRead: 189000,
            cacheWrite: 9300,
            total: 214900,
        });
        expect(read.cost).toBeCloseTo(0.45 + live.cost.total, 10);
    });

    it("reads the context of the running response from its own tokens", () => {
        // The response that streams has been given the whole context and has written its
        // answer since: its own count is the context pi will read once the response is
        // over, and pi trusts that count over its estimate wherever it has one.
        const live = usage({ input: 100000, output: 5000, cacheRead: 0, cacheWrite: 0, totalTokens: 105000 });

        const read = withLiveUsage(stats, live)!;

        expect(read.contextUsage?.tokens).toBe(105000);
        expect(read.contextUsage?.percent).toBeCloseTo((105000 / 512000) * 100, 10);
    });

    it("counts the parts of a usage that names no total", () => {
        const live = usage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 0 });

        expect(withLiveUsage(stats, live)?.contextUsage?.tokens).toBe(100);
    });

    it("leaves the context reading alone when pi names no window", () => {
        const unknown = sessionStats({ contextUsage: undefined });
        const live = usage({ totalTokens: 4200 });

        const read = withLiveUsage(unknown, live)!;

        expect(read.contextUsage).toBeUndefined();
        expect(read.tokens.total).toBeGreaterThan(unknown.tokens.total);
    });
});
