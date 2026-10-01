import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EntriesData } from "@/lib/protocol";
import { classifyRecord, lastAssistantText, parseFixture, responseData, streamedText } from "@/preview/fixtures";

/**
 * Regression tests for the preview pipeline: the recorded Rust corpus has to
 * stay readable by the Storybook replay helpers. Protocol conformance itself is
 * Rust's (`src-tauri/src/pi_rpc`), not this file's.
 */
const fixturesDir = resolve(import.meta.dirname, "../../../src-tauri/tests/fixtures");

function fixtureFiles(): string[] {
    return readdirSync(fixturesDir).filter((name) => name.endsWith(".jsonl"));
}

function fixtureText(name: string): string {
    return readFileSync(resolve(fixturesDir, name), "utf8");
}

describe("preview fixture replay", () => {
    it("finds the recorded corpus the previews depend on", () => {
        expect(existsSync(fixturesDir), `Rust fixture corpus missing at ${fixturesDir}`).toBe(true);
        expect(fixtureFiles().length).toBeGreaterThan(0);
    });

    it("classifies every recorded line into a known record kind", () => {
        const kinds = new Set<string>();
        for (const name of fixtureFiles()) {
            const records = parseFixture(fixtureText(name));
            expect(records.length, `${name} produced no records`).toBeGreaterThan(0);
            for (const record of records) {
                expect(record.kind, `${name}: ${JSON.stringify(record).slice(0, 120)}`).not.toBe("unclassifiable");
                kinds.add(record.kind);
            }
        }
        expect(kinds).toEqual(new Set(["response", "event", "extension_ui_request", "extension_error"]));
    });

    it("keeps a non-JSON line as unclassifiable instead of throwing", () => {
        expect(classifyRecord("not json").kind).toBe("unclassifiable");
    });

    it("decodes the transcript fixture's entry payload for stories", () => {
        const records = parseFixture(fixtureText("transcript-0.99.2.jsonl"));
        const data = responseData<EntriesData>(records, "get_entries");
        expect(data).toBeDefined();
        const roles = (data?.entries ?? []).map((entry) =>
            entry.type === "message" ? entry.message.role : entry.type,
        );
        expect(roles).toContain("assistant");
        expect(roles).toContain("toolResult");
    });

    it("reconstructs the same assistant text from deltas and from the final message", () => {
        const records = parseFixture(fixtureText("failures-0.99.2.jsonl"));
        const final = lastAssistantText(records);
        expect(final).toBeTruthy();
        expect(streamedText(records)).toContain("pie project");
        expect(final).toContain("pie project");
    });
});
