import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import * as bridge from "@/lib/bridge";
import { connectionMachine, type ConnectionDeps } from "@/machines/connection.machine";

/**
 * A bridge that answers what a test tells it to, and remembers what it was
 * asked. Nothing here starts pi: the machine is what is under test, and the
 * bridge is only how the machine reaches the outside.
 */
function fakeDeps(overrides: Partial<ConnectionDeps> = {}) {
    let publish: ((state: bridge.ConnectionState) => void) | undefined;
    let subscribed = "";
    let unsubscribed = "";

    const deps: ConnectionDeps = {
        connection: "main",
        connect: vi.fn(async () => ({
            id: "main",
            endpoint: "local",
            sessions: [{ id: "main:0", cwd: "/home/pie" }],
        })),
        trustHostKey: vi.fn(async () => true),
        onConnectionState: vi.fn(async (id, onState) => {
            subscribed = id;
            publish = onState;
            return () => {
                unsubscribed = id;
            };
        }),
        ...overrides,
    };

    return {
        deps,
        /** Puts a host-key question on the wire, as Rust would mid-handshake. */
        askHostKey: (key: bridge.PresentedKey) => publish?.({ type: "host_key", key }),
        subscribed: () => subscribed,
        unsubscribed: () => unsubscribed,
    };
}

/**
 * A dial that stays open until the test says otherwise — what a real handshake
 * is, and what makes the substates of `connecting` observable at all. Without it
 * `connect` settles within a tick and every question about "while it runs"
 * would be asked of a graph that has already finished.
 */
function pendingDeps(overrides: Partial<ConnectionDeps> = {}) {
    let release: ((info: bridge.ConnectionInfo) => void) | undefined;
    let fail: ((thrown: unknown) => void) | undefined;
    const harness = fakeDeps({
        connect: () =>
            new Promise<bridge.ConnectionInfo>((resolve, reject) => {
                release = resolve;
                fail = reject;
            }),
        ...overrides,
    });
    return {
        ...harness,
        settle: (info: bridge.ConnectionInfo = { id: "main", endpoint: "local", sessions: [] }) => release?.(info),
        failWith: (thrown: unknown) => fail?.(thrown),
    };
}

const KEY: bridge.PresentedKey = {
    host: "192.168.1.10",
    port: 22,
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:2a:b4:c1:88:9f:0e",
};

const SPEC: bridge.ConnectSpec = { transport: "local" };

describe("connectionMachine", () => {
    it("reaches connected through the happy path, and unsubscribes on the way out", async () => {
        const harness = fakeDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        expect(actor.getSnapshot().matches("connecting")).toBe(true);

        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));
        expect(actor.getSnapshot().context.info?.endpoint).toBe("local");
        expect(harness.unsubscribed()).toBe("main");
    });

    it("subscribes before it dials, so the question cannot arrive unheard", async () => {
        // The host-key question lands while `connect` is still pending. A
        // listener registered after the dial would have missed it.
        const order: string[] = [];
        const harness = fakeDeps({
            onConnectionState: async () => {
                order.push("listen");
                return () => undefined;
            },
            connect: async () => {
                order.push("connect");
                return { id: "main", endpoint: "local", sessions: [] };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));

        expect(order).toEqual(["listen", "connect"]);
    });

    it("reports a listener that never arrives as a failed handshake", async () => {
        // Without a listener the host-key question goes unheard, so this is a
        // failure like any other — and it has to be one, or the form stays
        // locked on "Connecting" with nothing left to unlock it.
        const harness = fakeDeps({
            onConnectionState: async () => {
                throw new Error("no IPC bridge here");
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });

        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));
        expect(actor.getSnapshot().context.error).toEqual({
            type: "internal",
            message: "no IPC bridge here",
        });
        expect(harness.deps.connect).not.toHaveBeenCalled();
    });

    it("asks while it waits, and only while a handshake is in flight", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        // Outside the handshake there is nobody to ask, and the graph says so.
        actor.send({ type: "HOST_KEY", key: KEY });
        expect(actor.getSnapshot().matches("idle")).toBe(true);

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);

        expect(actor.getSnapshot().matches({ connecting: "asking" })).toBe(true);
        expect(actor.getSnapshot().context.hostKey).toEqual(KEY);
    });

    it("keeps waiting when the answer itself cannot be delivered", async () => {
        // Nothing to fail on in Rust today, so this is the IPC boundary rather
        // than the protocol: without a listener-side `onError` the rejected actor
        // is dropped and the machine sits in `answering` for good — the prompt is
        // already gone and the form is locked, with no event left to reach it.
        const harness = pendingDeps({
            trustHostKey: async () => {
                throw new Error("no IPC bridge here");
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);
        actor.send({ type: "ANSWER_HOST_KEY", trusted: true });
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ connecting: "answering" })).toBe(true));

        // Back to waiting, so the handshake's own ending is what reports the
        // outcome: Rust gives up on the question and the dial fails with it.
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ connecting: "waiting" })).toBe(true));

        harness.failWith({ type: "host_key", message: "nobody answered whether to trust this host key" });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));
        expect(actor.getSnapshot().context.error?.type).toBe("host_key");
    });

    it("answers once, and the question comes down while the handshake runs on", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);
        actor.send({ type: "ANSWER_HOST_KEY", trusted: true });

        await vi.waitFor(() => expect(harness.deps.trustHostKey).toHaveBeenCalledWith("main", true));
        // Still reaching the host, which is where the answer's consequence shows
        // up: the sheet is gone but nothing has been decided yet.
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ connecting: "waiting" })).toBe(true));
        expect(actor.getSnapshot().context.hostKey).toBeNull();

        harness.settle();
        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));
    });

    it("refuses as readily as it trusts: a dismissal is an answer", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);
        actor.send({ type: "ANSWER_HOST_KEY", trusted: false });

        await vi.waitFor(() => expect(harness.deps.trustHostKey).toHaveBeenCalledWith("main", false));
    });

    it("reports a refused host key as the category Rust gave it", async () => {
        const harness = fakeDeps({
            connect: async () => {
                throw { type: "host_key", message: "the key at 192.168.1.10:22 is not the one on record" };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));
        expect(actor.getSnapshot().context.error).toEqual({
            type: "host_key",
            message: "the key at 192.168.1.10:22 is not the one on record",
        });
    });

    it("unlocks for a retry, and clearing the line takes it back to idle", async () => {
        const harness = fakeDeps({
            connect: async () => {
                throw { type: "transport", message: "connection refused" };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));

        actor.send({ type: "CONNECT", spec: SPEC });
        expect(actor.getSnapshot().matches("connecting")).toBe(true);
        expect(actor.getSnapshot().context.error).toBeNull();
    });

    it("takes a dismissed failure back to a clean idle, with nothing left over", async () => {
        const harness = fakeDeps({
            connect: async () => {
                throw { type: "process", message: "pi is not on PATH" };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));

        actor.send({ type: "DISMISS" });
        expect(actor.getSnapshot().matches("idle")).toBe(true);
        expect(actor.getSnapshot().context.error).toBeNull();
    });

    it("never asks once the handshake is over", async () => {
        const harness = fakeDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));

        actor.send({ type: "HOST_KEY", key: KEY });

        expect(actor.getSnapshot().matches("connected")).toBe(true);
        expect(actor.getSnapshot().context.hostKey).toBeNull();
    });

    it("stops listening once the question is replaced rather than answered", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));

        actor.stop();
        // One listener per handshake: a replaced question is Rust's business,
        // and this actor's channel is no longer the one carrying it.
        expect(harness.unsubscribed()).toBe("main");
        expect(actor.getSnapshot().status).toBe("stopped");
    });
});
