/**
 * The one signal that a read failed: which reads can carry news of the reach, and
 * that a listener hears every report and only while it asked.
 */

import { describe, expect, it, vi } from "vitest";
import { isReachRead, reportReachFailure, subscribeToReachFailures } from "../health";

describe("a failed read against the reach", () => {
    it("counts every read of the machine, and not the read of the connection itself", () => {
        // The reads of a session, of its transcript, and of the session list are all
        // questions to the machine; their failure can be the first news that the reach went.
        expect(isReachRead(["session", "main:1", "state"])).toBe(true);
        expect(isReachRead(["session", "main:1", "entries"])).toBe(true);

        // The connection read is the question itself. Asking it again because it failed
        // would repeat the failure, not answer it.
        expect(isReachRead(["connection"])).toBe(false);
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
