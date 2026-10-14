/**
 * The one signal that a read failed against the reach: which failures count as the reach's,
 * and that a listener hears every one and only what it asked for.
 */

import { describe, expect, it, vi } from "vitest";
import { isReachFailure, reportReachFailure, subscribeToReachFailures } from "@/lib/connection-health";

describe("a failed read against the reach", () => {
    it("counts the failures that can carry a lost reach, and not the ones behind it", () => {
        expect(isReachFailure({ type: "channel", message: "the program ended" })).toBe(true);
        expect(isReachFailure({ type: "host", message: "the host never answered" })).toBe(true);
        // A closed transport arrives here, and a pi that exited arrives the same way: the
        // failure only says which of the two to ask Rust about.
        expect(isReachFailure({ type: "rpc", message: "closed: transport closed" })).toBe(true);

        // pi behind a live reach, and the IPC itself: neither is a connection that ended.
        expect(isReachFailure({ type: "session", message: "unknown session" })).toBe(false);
        expect(isReachFailure({ type: "commands", message: "no such command" })).toBe(false);
        expect(isReachFailure(new Error("the host never answered"))).toBe(false);
        expect(isReachFailure("a string Tauri rejected with")).toBe(false);
        expect(isReachFailure(null)).toBe(false);
    });

    it("tells every listener, and stops telling the one that left", () => {
        const heard = vi.fn();
        const leaving = vi.fn();
        subscribeToReachFailures(heard);
        const stop = subscribeToReachFailures(leaving);

        reportReachFailure();
        expect(heard).toHaveBeenCalledTimes(1);
        expect(leaving).toHaveBeenCalledTimes(1);

        stop();
        reportReachFailure();
        expect(heard).toHaveBeenCalledTimes(2);
        expect(leaving).toHaveBeenCalledTimes(1);
    });
});
