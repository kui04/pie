import { describe, expect, it } from "vitest";
import {
    breatheAt,
    formatCwd,
    groupSessions,
    matchesSearch,
    pathKey,
    relativeTime,
    sessionTitle,
} from "@/routes/chat/sidebar/session-list";
import { sessionSummary } from "@/preview/fixtures";

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
        expect(breatheAt(1200)).toBeCloseTo(1, 3);
        expect(breatheAt(2400)).toBeCloseTo(0.35, 3);
    });

    it("has no seam: the cycle starts where the one before it ended", () => {
        // The value just before a cycle ends is the value just after one starts, so
        // the light does not jump when the count wraps.
        expect(breatheAt(2399)).toBeCloseTo(breatheAt(0), 3);
    });
});

describe("formatCwd", () => {
    it("returns 'No directory' when cwd is empty", () => {
        expect(formatCwd("")).toBe("No directory");
        expect(formatCwd("", "/home/user")).toBe("No directory");
    });

    it("returns '~' when cwd equals the home directory", () => {
        expect(formatCwd("/home/user", "/home/user")).toBe("~");
        expect(formatCwd("/home/user/", "/home/user")).toBe("~");
    });

    it("replaces home prefix with '~/' for subdirectories", () => {
        expect(formatCwd("/home/user/pie", "/home/user")).toBe("~/pie");
        expect(formatCwd("/home/user/pie/nested", "/home/user")).toBe("~/pie/nested");
    });

    it("handles Windows backslashes using pathe", () => {
        expect(formatCwd("C:\\Users\\user\\pie", "C:\\Users\\user")).toBe("~/pie");
    });

    it("returns normalized cwd when cwd is outside the home directory", () => {
        expect(formatCwd("/var/log", "/home/user")).toBe("/var/log");
        expect(formatCwd("/work/pie", "/home/user")).toBe("/work/pie");
    });

    it("returns normalized cwd when homePath is omitted", () => {
        expect(formatCwd("/work/pie")).toBe("/work/pie");
    });
});
