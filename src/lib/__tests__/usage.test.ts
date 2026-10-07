import { describe, expect, it } from "vitest";
import { costText, formatTokens, percentText, tokenBreakdown, usageTone } from "@/lib/usage";

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
