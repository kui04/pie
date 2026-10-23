import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import * as bridge from "@/lib/bridge";
import { connectionMachine, type ConnectionDeps } from "@/machines/connection.machine";

/**
 * A bridge that answers what a test tells it to, and records each request.
 * Nothing here starts pi. The machine is under test. The bridge is only the path
 * of the machine to the outside.
 */
function fakeDeps(overrides: Partial<ConnectionDeps> = {}) {
    let publish: ((state: bridge.ConnectionState) => void) | undefined;
    let subscribed = "";
    let unsubscribed = "";
    let unlistenCalls = 0;

    const deps: ConnectionDeps = {
        connection: "main",
        connect: vi.fn(async () => ({
            id: "main",
            endpoint: "local",
            sessions: [{ id: "main:0", cwd: "/home/pie" }],
            open: true,
        })),
        trustHostKey: vi.fn(async () => true),
        onConnectionState: vi.fn(async (id, onState) => {
            subscribed = id;
            publish = onState;
            return () => {
                unsubscribed = id;
                unlistenCalls += 1;
            };
        }),
        notify: vi.fn(),
        onHostKey: vi.fn(),
        ...overrides,
    };

    return {
        deps,
        /** Puts a host-key question on the wire, as Rust does during the handshake. */
        askHostKey: (key: bridge.PresentedKey) => publish?.({ type: "host_key", key }),
        subscribed: () => subscribed,
        unsubscribed: () => unsubscribed,
        unlistenCalls: () => unlistenCalls,
    };
}

/**
 * A dial that stays open until the test says otherwise. A real handshake does
 * this, and the substates of `connecting` are observable only during the dial.
 * Without it, `connect` completes in one tick, and no test can ask a question
 * about the time during the dial.
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
        settle: (info: bridge.ConnectionInfo = { id: "main", endpoint: "local", sessions: [], open: true }) =>
            release?.(info),
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
        expect(harness.unsubscribed()).toBe("main");
        expect(harness.unlistenCalls()).toBe(1);
    });

    it("subscribes before it dials, so the question cannot arrive unheard", async () => {
        // The host-key question arrives while `connect` is still pending. A
        // listener registered after the dial misses it.
        const order: string[] = [];
        const harness = fakeDeps({
            onConnectionState: async () => {
                order.push("listen");
                return () => undefined;
            },
            connect: async () => {
                order.push("connect");
                return { id: "main", endpoint: "local", sessions: [], open: true };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));

        expect(order).toEqual(["listen", "connect"]);
    });

    it("reports a listener that never arrives as a failed handshake", async () => {
        // Without a listener, the host-key question goes unheard. Therefore this
        // is a failure like any other. The form must not stay locked on
        // "Connecting".
        const harness = fakeDeps({
            onConnectionState: async () => {
                throw new Error("no IPC bridge here");
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });

        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));
        expect(actor.getSnapshot().context.error).toEqual({
            kind: "unreached",
            message: "no IPC bridge here",
        });
        expect(harness.deps.connect).not.toHaveBeenCalled();
    });

    it("unsubscribes once when the handshake fails", async () => {
        // The failure path must not drop the listener. If it does,
        // `plugin:event|unlisten` goes twice for one listener. Leaving
        // `connecting` stops the handshake actor, and the cleanup of the actor
        // owns the listener.
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));

        harness.failWith(new Error("connection refused"));
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));

        expect(harness.unlistenCalls()).toBe(1);
    });

    it("drops the question when the handshake fails while it is on screen", async () => {
        // A host key without an answer reaches the timeout in Rust. The failure
        // arrives while the question is on screen. The prompt is open only while
        // `hostKey` is set. If it stays set, the sheet stays over the error, and
        // no event can close it.
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);
        expect(harness.deps.onHostKey).toHaveBeenCalledWith(KEY);

        harness.failWith(new Error("host never answered"));
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));

        expect(harness.deps.onHostKey).toHaveBeenLastCalledWith(null);
        // No question is open. The answer has no handler here.
        actor.send({ type: "ANSWER_HOST_KEY", trusted: false });
        expect(actor.getSnapshot().matches("error")).toBe(true);
        expect(harness.deps.onHostKey).toHaveBeenLastCalledWith(null);
    });

    it("drops the question when the handshake succeeds with one still up", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);
        harness.settle();

        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));
        expect(harness.deps.onHostKey).toHaveBeenLastCalledWith(null);
    });

    it("asks while it waits, and only while a handshake is in flight", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        // Outside the handshake, there is no one to ask. The graph shows this.
        actor.send({ type: "HOST_KEY", key: KEY });
        expect(actor.getSnapshot().matches("idle")).toBe(true);

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);

        expect(actor.getSnapshot().matches({ connecting: "asking" })).toBe(true);
        expect(harness.deps.onHostKey).toHaveBeenCalledWith(KEY);
    });

    it("keeps waiting when the answer itself cannot be delivered", async () => {
        // Rust has nothing to fail on today. Therefore this failure is the IPC
        // boundary, not the protocol. Without `onError`, the rejected actor is
        // dropped and the machine stays in `answering`. The prompt is gone and
        // the form is locked.
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

        // The machine goes back to `waiting`. The end of the handshake reports
        // the result. Rust gives up on the question, and the dial fails.
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ connecting: "waiting" })).toBe(true));

        harness.failWith({
            kind: "failed",
            message: "nobody answered whether to trust this host key",
        });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));
        expect(actor.getSnapshot().context.error?.kind).toBe("failed");
    });

    it("answers once, and the question comes down while the handshake runs on", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));
        harness.askHostKey(KEY);
        actor.send({ type: "ANSWER_HOST_KEY", trusted: true });

        await vi.waitFor(() => expect(harness.deps.trustHostKey).toHaveBeenCalledWith("main", true));
        // The dial continues. The result of the answer is not visible yet. The
        // sheet is gone, but the handshake has not decided.
        await vi.waitFor(() => expect(actor.getSnapshot().matches({ connecting: "waiting" })).toBe(true));
        expect(harness.deps.onHostKey).toHaveBeenLastCalledWith(null);

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

    it("reports a refused host key as the sentence Rust wrote", async () => {
        const harness = fakeDeps({
            connect: async () => {
                throw {
                    kind: "failed",
                    message: "the key at 192.168.1.10:22 is not the one on record",
                };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));
        expect(actor.getSnapshot().context.error).toEqual({
            kind: "failed",
            message: "the key at 192.168.1.10:22 is not the one on record",
        });
    });

    it("unlocks for a retry, and clears the failure", async () => {
        const harness = fakeDeps({
            connect: async () => {
                throw { kind: "failed", message: "connection refused" };
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));

        actor.send({ type: "CONNECT", spec: SPEC });
        expect(actor.getSnapshot().matches("connecting")).toBe(true);
        expect(actor.getSnapshot().context.error).toBeNull();
    });

    it("announces each failure once, through the injected notify", async () => {
        const harness = fakeDeps({
            connect: async () => {
                throw new Error("connection refused");
            },
        });
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true));

        expect(harness.deps.notify).toHaveBeenCalledTimes(1);
        expect(harness.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ message: "connection refused" }));
    });

    it("never asks once the handshake is over", async () => {
        const harness = fakeDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(actor.getSnapshot().matches("connected")).toBe(true));

        actor.send({ type: "HOST_KEY", key: KEY });

        expect(actor.getSnapshot().matches("connected")).toBe(true);
        // The handshake exit withdraws with null; no question content ever routes.
        expect(harness.deps.onHostKey).not.toHaveBeenCalledWith(expect.anything());
    });

    it("stops listening when the actor is stopped", async () => {
        const harness = pendingDeps();
        const actor = createActor(connectionMachine, { input: harness.deps }).start();

        actor.send({ type: "CONNECT", spec: SPEC });
        await vi.waitFor(() => expect(harness.subscribed()).toBe("main"));

        actor.stop();
        // One listener for each handshake, and stopping the actor is what drops
        // it. A question that Rust replaces never returns to this channel, so
        // there is no second subscription to leave behind.
        expect(harness.unsubscribed()).toBe("main");
        expect(actor.getSnapshot().status).toBe("stopped");
    });
});
