import { describe, expect, it } from "vitest";
import { BREATHE_CYCLE } from "@/lib/motion";
import {
    breatheAt,
    costText,
    formatTokens,
    groupSessions,
    matchesSearch,
    pathKey,
    percentText,
    relativeTime,
    sessionTitle,
    tokenBreakdown,
    usageTone,
    withLiveUsage,
} from "@/routes/chat/components/session/session";
import { sessionStats, sessionSummary, usage } from "@/preview/fixtures";

describe("groupSessions", () => {
    it("puts the sessions of one directory together, the newest written first", () => {
        const old = sessionSummary({ cwd: "/b", modified: "2026-01-01T00:00:00.000Z" });
        const fresh = sessionSummary({ cwd: "/a", modified: "2026-01-03T00:00:00.000Z" });
        const middle = sessionSummary({ cwd: "/a", modified: "2026-01-02T00:00:00.000Z" });

        const groups = groupSessions([fresh, old, middle]);

        expect(groups.map((group) => group.cwd)).toEqual(["/a", "/b"]);
        // A group keeps the order the listing gave it: Rust sorts the rows, and
        // this only decides where the groups break.
        expect(groups[0].sessions.map((session) => session.modified)).toEqual([
            "2026-01-03T00:00:00.000Z",
            "2026-01-02T00:00:00.000Z",
        ]);
    });

    it("keeps a session with no directory of its own apart, and last", () => {
        const named = sessionSummary({ cwd: "/a", modified: "2026-01-01T00:00:00.000Z" });
        // Files older than the `cwd` field of pi report no directory at all.
        const ancient = sessionSummary({ cwd: "", modified: "2026-01-09T00:00:00.000Z" });

        expect(groupSessions([named, ancient]).map((group) => group.cwd)).toEqual(["/a", ""]);
    });

    it("answers with nothing to draw for an empty listing", () => {
        expect(groupSessions([])).toEqual([]);
    });
});

describe("sessionTitle", () => {
    it("says the name pi holds", () => {
        expect(sessionTitle(sessionSummary({ name: "Fix the parser" }))).toBe("Fix the parser");
    });

    it("falls back to the words that opened the conversation, in one line", () => {
        const session = sessionSummary({ name: null, firstMessage: "  two\nlines  " });
        expect(sessionTitle(session)).toBe("two lines");
    });

    it("has no title for a session pi holds nothing about", () => {
        expect(sessionTitle(sessionSummary({ name: "", firstMessage: null }))).toBeNull();
        expect(sessionTitle(sessionSummary({ name: null, firstMessage: "   " }))).toBeNull();
    });
});

describe("relativeTime", () => {
    const now = Date.parse("2026-01-08T12:00:00.000Z");
    const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

    it("counts up through the units a row is written in", () => {
        expect(relativeTime(ago(0), now)).toBe("now");
        expect(relativeTime(ago(59), now)).toBe("now");
        expect(relativeTime(ago(60), now)).toBe("1m");
        expect(relativeTime(ago(59 * 60), now)).toBe("59m");
        expect(relativeTime(ago(60 * 60), now)).toBe("1h");
        expect(relativeTime(ago(23 * 3600), now)).toBe("23h");
        expect(relativeTime(ago(24 * 3600), now)).toBe("1d");
        expect(relativeTime(ago(6 * 24 * 3600), now)).toBe("6d");
        expect(relativeTime(ago(7 * 24 * 3600), now)).toBe("1w");
        expect(relativeTime(ago(29 * 24 * 3600), now)).toBe("4w");
        expect(relativeTime(ago(30 * 24 * 3600), now)).toBe("1mo");
        expect(relativeTime(ago(364 * 24 * 3600), now)).toBe("12mo");
        expect(relativeTime(ago(365 * 24 * 3600), now)).toBe("1y");
    });

    it("does not go below zero when the clock of the host is ahead", () => {
        expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe("now");
    });

    it("says nothing of a stamp it cannot read", () => {
        // A hand-edited file, or a field a later pi writes differently: the row
        // shows no time rather than counting NaN years.
        expect(relativeTime("not a time", now)).toBe("--");
        expect(relativeTime("", now)).toBe("--");
    });
});

describe("matchesSearch", () => {
    const session = sessionSummary({
        name: "Fix the parser",
        firstMessage: "Make the parser skip empty lines",
        cwd: "/home/kui/Projects/pie",
        path: "/home/kui/.pi/agent/sessions/--home-kui-Projects-pie--/one.jsonl",
    });

    it("takes every row when nothing is asked", () => {
        expect(matchesSearch(session, "")).toBe(true);
        expect(matchesSearch(session, "   ")).toBe(true);
    });

    it("finds a session by its name, its first words, or its project", () => {
        expect(matchesSearch(session, "PARSER")).toBe(true);
        expect(matchesSearch(session, "skip empty")).toBe(true);
        expect(matchesSearch(session, "projects/pie")).toBe(true);
        expect(matchesSearch(session, "one.jsonl")).toBe(true);
        expect(matchesSearch(session, "translator")).toBe(false);
    });

    it("reads a field that is not there as no match", () => {
        const unnamed = sessionSummary({ cwd: "", name: null, firstMessage: null });
        expect(matchesSearch(unnamed, "xyz")).toBe(false);
    });
});

describe("pathKey", () => {
    const one = "/home/kui/.pi/agent/sessions/--home-kui-pie--/2026-10-07T12-00-00-000Z_one.jsonl";

    it("answers the same key for the same path, and another for another path", () => {
        expect(pathKey(one)).toBe(pathKey(one));
        expect(pathKey(one)).not.toBe(pathKey(one.replace("one.jsonl", "two.jsonl")));
    });

    it("holds nothing that a selector reads as syntax", () => {
        // `/`, `:` and `.` are all through a path of this host, and none of them may
        // reach the id of a row.
        expect(pathKey(one)).toMatch(/^[0-9a-z]+$/);
    });
});

describe("breatheAt", () => {
    it("starts dim, is brightest in the middle of the cycle, and comes back", () => {
        expect(breatheAt(0)).toBeCloseTo(0.35, 3);
        expect(breatheAt(BREATHE_CYCLE / 2)).toBeCloseTo(1, 3);
        expect(breatheAt(BREATHE_CYCLE)).toBeCloseTo(0.35, 3);
    });

    it("has no seam: the cycle starts where the one before it ended", () => {
        // The value just before a cycle ends is the value just after one starts, so
        // the light does not jump when the count wraps.
        expect(breatheAt(BREATHE_CYCLE - 1)).toBeCloseTo(breatheAt(0), 3);
    });
});

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
        const unknown = sessionStats({ contextUsage: null });
        const live = usage({ totalTokens: 4200 });

        const read = withLiveUsage(unknown, live)!;

        expect(read.contextUsage).toBeNull();
        expect(read.tokens.total).toBeGreaterThan(unknown.tokens.total);
    });
});
