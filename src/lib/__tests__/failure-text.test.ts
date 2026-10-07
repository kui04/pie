import { describe, expect, it } from "vitest";
import { MODULE_REASON, reasonFor, type FailureText } from "@/lib/failure-text";

const table: FailureText = { unknown_session: "That session is gone." };

describe("the words a failure gets", () => {
    it("uses the sentence of the screen for a failure it names", () => {
        const failure = { type: "connection" as const, message: "raw", error: { kind: "unknown_session" } };

        expect(reasonFor(failure, table)).toBe("That session is gone.");
    });

    it("falls back to the sentence of the module for one it does not name", () => {
        const failure = { type: "rpc" as const, message: "raw", error: { kind: "something_new" } };

        expect(reasonFor(failure, table)).toBe(MODULE_REASON.rpc);
    });

    it("falls back when the failure carries no name at all", () => {
        // An I/O failure has no kind: its sentence comes from the platform.
        const failure = { type: "io" as const, message: "raw" };

        expect(reasonFor(failure, table)).toBe(MODULE_REASON.io);
    });
});
