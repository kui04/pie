/**
 * The one place every failed read passes, and the one thing it does beyond saying so: a
 * failure of the reach is also the earliest news of a connection that ended, and the boundary
 * hears it here.
 *
 * The join is what this file pins. What the boundary then does with it is tested where the
 * boundary lives (`hooks/__tests__/useConnectionWatch.test.tsx`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query } from "@tanstack/react-query";
import type * as Bridge from "@/lib/bridge";
import { subscribeToReachFailures } from "../health";
import { connectionQueries, queryClient, statsPoll } from "../index";

const fake = vi.hoisted(() => ({
    getConnection: vi.fn<() => Promise<Bridge.ConnectionInfo | null>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...fake,
}));

/** A failure as the boundary really receives one: the plain object Rust rejected with. */
function aFailure(message: string): Error {
    return { kind: "failed", message } as unknown as Error;
}

/** What the cache is handed when it reports: the hash for the log, and the key for the rule. */
function aQuery(queryKey: readonly unknown[]): Query<unknown, unknown, unknown, readonly unknown[]> {
    return { queryHash: JSON.stringify(queryKey), queryKey } as unknown as Query<
        unknown,
        unknown,
        unknown,
        readonly unknown[]
    >;
}

describe("a read that failed", () => {
    let stop: (() => void) | undefined;

    afterEach(() => {
        stop?.();
        stop = undefined;
    });

    it("tells the boundary when a read of the machine failed", () => {
        const heard = vi.fn();
        stop = subscribeToReachFailures(heard);

        queryClient
            .getQueryCache()
            .config.onError?.(aFailure("the host never answered"), aQuery(["session", "main:1", "entries"]));

        expect(heard).toHaveBeenCalledTimes(1);
    });

    it("leaves the boundary alone when the read of the connection itself failed", () => {
        const heard = vi.fn();
        stop = subscribeToReachFailures(heard);

        // The connection read is the question itself: asking it again because it failed
        // would repeat the failure, not answer it.
        queryClient.getQueryCache().config.onError?.(aFailure("the IPC did not answer"), aQuery(["connection"]));

        expect(heard).not.toHaveBeenCalled();
    });
});

/**
 * The one read whose answer can change with nobody announcing it: the gate dials a connection
 * and the workspace reads it back. Time is what makes it news, and a failure is not worth a
 * second ask - Rust says what is there, now.
 */
describe("the read of the connection", () => {
    it("is the app's one connection, under the key its invalidations use", () => {
        expect(connectionQueries.current().queryKey).toEqual(["connection"]);
    });

    it("is read again when it is asked for, because nothing announces a new connection", () => {
        expect(connectionQueries.current().staleTime).toBe(0);
    });

    it("answers what Rust holds, and `null` is an answer and not a failure", async () => {
        // What TanStack hands a query function, and this read uses none of it.
        const asked = {} as never;
        fake.getConnection.mockResolvedValue(null);
        expect(await connectionQueries.current().queryFn?.(asked)).toBeNull();

        const info: Bridge.ConnectionInfo = {
            id: "main",
            endpoint: "local",
            sessions: [{ id: "main:0", cwd: "/home/pie" }],
            open: true,
        };
        fake.getConnection.mockResolvedValue(info);
        expect(await connectionQueries.current().queryFn?.(asked)).toEqual(info);
    });

    it("does not ask a second time when it fails", () => {
        expect(connectionQueries.current().retry).toBe(false);
    });
});

describe("the fallback read of the usage", () => {
    it("asks nothing of a session that has nothing running", () => {
        // An idle session changes no counts between events: only a record can, and the chart
        // asks for the reads those make stale. A run that streams for minutes is the one that
        // needs the fallback.
        expect(statsPoll("idle")).toBe(false);
        expect(statsPoll("waiting")).not.toBe(false);
        expect(statsPoll("working")).not.toBe(false);
    });

    it("stops asking a read that failed, and keeps asking otherwise", () => {
        const poll = statsPoll("working");
        if (poll === false) throw new Error("a working session must poll");

        expect(poll({ state: { status: "error" } })).toBe(false);
        expect(poll({ state: { status: "success" } })).toBe(30_000);
        expect(poll({ state: { status: "pending" } })).toBe(30_000);
    });
});
