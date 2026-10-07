import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { EntriesData, Event, SessionEntry, SessionState, SessionStats } from "@/lib/protocol";
import { statsRefetchInterval, useSession } from "@/hooks/use-session";
import { queryDefaults } from "@/lib/query";
import { useTranscriptStore } from "@/stores/transcript.store";

/**
 * The order of the two reads and the writing of the store, with a bridge that
 * answers what a test tells it to. Nothing here starts pi: the hook is under
 * test, and the bridge is only its path to the outside.
 */

const AT = "2026-10-05T00:00:00.000Z";

const fake = vi.hoisted(() => ({
    getState: vi.fn<(session: string) => Promise<SessionState>>(),
    getEntries: vi.fn<(session: string) => Promise<EntriesData>>(),
    getSessionStats: vi.fn<(session: string) => Promise<SessionStats>>(),
    onSessionEvent: vi.fn<(session: string, onEvent: (event: Event) => void) => Promise<Bridge.Unsubscribe>>(),
    onSessionState:
        vi.fn<(session: string, onState: (state: Bridge.SessionLifecycle) => void) => Promise<Bridge.Unsubscribe>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...fake,
}));

/** A promise that a test settles when it is ready. */
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function userMessage(id: string, parentId: string | null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: AT,
        message: { role: "user", content: `text of ${id}`, timestamp: 0 },
    };
}

function snapshot(entries: SessionEntry[], leafId: string | null): EntriesData {
    return { entries, leafId };
}

/** The publishing end of the two subscriptions, once they are open. */
let publish: ((event: Event) => void) | undefined;
let ended: (() => void) | undefined;
let listened: string[] = [];
let unlistened: string[] = [];

describe("the session of the workspace", () => {
    let client: QueryClient;
    let subscribed: ReturnType<typeof deferred>;

    beforeEach(() => {
        useTranscriptStore.getState().clear();
        publish = undefined;
        ended = undefined;
        listened = [];
        unlistened = [];
        subscribed = deferred();

        fake.getState.mockReset().mockResolvedValue({} as SessionState);
        fake.getSessionStats.mockReset().mockResolvedValue({} as SessionStats);
        fake.getEntries.mockReset().mockResolvedValue(snapshot([userMessage("a", null)], "a"));
        fake.onSessionEvent.mockReset().mockImplementation(async (session, onEvent) => {
            await subscribed.promise;
            listened.push(`event:${session}`);
            publish = onEvent;
            return () => unlistened.push(`event:${session}`);
        });
        fake.onSessionState.mockReset().mockImplementation(async (session, onState) => {
            await subscribed.promise;
            listened.push(`state:${session}`);
            ended = () => onState({ type: "ended", termination: { type: "exited", code: 0, success: true } });
            return () => unlistened.push(`state:${session}`);
        });

        // No client-level retry: the reads themselves say that they do not retry,
        // and a test of that has to see the default they override.
        // The app's own defaults: with TanStack's (`staleTime: 0`) every warm
        // cache would look cold, and a second visit would read for that reason.
        client = new QueryClient(queryDefaults);
    });

    function render(session: string) {
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        return renderHook(({ id }) => useSession(id), { initialProps: { id: session }, wrapper });
    }

    it("reads nothing until both listeners are open", async () => {
        // The event bus has no replay: a snapshot pulled before the listener
        // exists would leave the records in between unaccounted for.
        const { result } = render("main:1");

        expect(result.current.listening).toBe(false);
        expect(fake.onSessionEvent).toHaveBeenCalledWith("main:1", expect.any(Function));
        expect(fake.getEntries).not.toHaveBeenCalled();

        subscribed.resolve();

        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledWith("main:1"));
        expect(result.current.listening).toBe(true);
        expect(listened).toEqual(["event:main:1", "state:main:1"]);
    });

    it("takes the snapshot as the transcript", async () => {
        fake.getEntries.mockResolvedValue(snapshot([userMessage("a", null), userMessage("b", "a")], "b"));
        render("main:1");
        subscribed.resolve();

        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a", "b"]));
        expect(useTranscriptStore.getState().leafId).toBe("b");
    });

    it("takes an appended entry and follows the new leaf", async () => {
        render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));

        publish?.({ type: "entry_appended", entry: userMessage("b", "a") });

        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a", "b"]));
        expect(useTranscriptStore.getState().leafId).toBe("b");
    });

    it("starts from nothing when the session changes", async () => {
        const mounted = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));

        const second = deferred();
        subscribed = second;
        mounted.rerender({ id: "main:2" });

        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual([]));
        second.resolve();
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledWith("main:2"));
    });

    it("reads again when the session ends", async () => {
        // The pi of the session is gone. A screen that shows the state or the
        // transcript reads again, and that read answers with the reason Rust
        // names. (The stale mark itself is not observable here: a query that is
        // mounted takes a refetch at once and clears it.)
        render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledTimes(1));
        const entries = fake.getEntries.mock.calls.length;
        const states = fake.getState.mock.calls.length;

        ended?.();

        await waitFor(() => expect(fake.getEntries.mock.calls.length).toBeGreaterThan(entries));
        expect(fake.getState.mock.calls.length).toBeGreaterThan(states);
    });

    it("forgets the failure of a session that opens on a later visit", async () => {
        // A session that could not be read once may be readable later. The
        // failure belongs to that attempt, not to the name of the session.
        fake.onSessionEvent.mockImplementationOnce(async () => {
            throw { type: "rpc", message: "the bus refused the listener", error: { kind: "closed" } };
        });
        const mounted = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(mounted.result.current.error?.message).toBe("the bus refused the listener"));

        const away = deferred();
        subscribed = away;
        mounted.rerender({ id: "main:2" });
        away.resolve();
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledWith("main:2"));

        const back = deferred();
        subscribed = back;
        mounted.rerender({ id: "main:1" });
        back.resolve();

        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledWith("main:1"));
        expect(mounted.result.current.error).toBeNull();
    });

    it("does not ask a second time when a read fails", async () => {
        // TanStack retries three times by default, which would report the reason
        // of a dead pi seconds after it is known.
        fake.getEntries.mockRejectedValue({
            type: "rpc",
            message: "the pi of this session is gone",
            error: { kind: "closed" },
        });
        const { result } = render("main:1");
        subscribed.resolve();

        await waitFor(() => expect(result.current.snapshot.isError).toBe(true));
        expect(fake.getEntries).toHaveBeenCalledTimes(1);
        expect(result.current.snapshot.error?.message).toBe("the pi of this session is gone");
    });

    it("reads again on a second visit, however warm the cache is", async () => {
        // A visit that ends closes both listeners. Whatever pi appends while
        // nobody listens is in no cache and on no channel, so the answer of the
        // last read may not stand for this visit - `staleTime` is `Infinity`, and
        // without this second read it would stand forever.
        //
        // The first visit waits for its answer to land in the store, which means
        // it landed in the cache too: a fetch that is still in flight is
        // cancelled when the last observer goes away, and the cache would hold
        // nothing - a second read would then happen for the wrong reason.
        const first = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));
        first.unmount();
        // What the visit before read is beside the point from here on: this test
        // is about whether this visit reads at all.
        fake.getEntries.mockClear();

        const again = deferred();
        subscribed = again;
        render("main:1");
        again.resolve();

        await waitFor(() => expect(fake.getEntries).toHaveBeenCalled());
    });

    it("does not write what the visit before read into the store", async () => {
        // The cache keeps the answer of the visit before, and a disabled query
        // hands it out all the same. What the store holds is what this visit
        // heard, and that starts at its own listeners.
        const first = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));
        first.unmount();

        const again = deferred();
        subscribed = again;
        fake.getEntries.mockClear();
        render("main:1");
        await vi.waitFor(() => expect(fake.onSessionEvent).toHaveBeenCalledTimes(2));

        expect(fake.getEntries).not.toHaveBeenCalled();
        expect(useTranscriptStore.getState().order).toEqual([]);

        again.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));
    });

    it("waits for the listeners of its own visit before it reads", async () => {
        // The listeners of the visit before are gone, and the reads cannot be
        // taken on their word. This hook is one component throughout: a session
        // change is not a new component, so nothing else resets what it remembers
        // as listening. The visit away is still in flight when this session comes
        // back, so what it remembers is this session, wrongly.
        const mounted = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));

        const away = deferred();
        subscribed = away;
        mounted.rerender({ id: "main:2" });

        const back = deferred();
        subscribed = back;
        fake.getEntries.mockClear();
        // A cold cache sends a read at once, so one that starts too early cannot
        // hide behind an answer that already landed.
        client.clear();
        mounted.rerender({ id: "main:1" });

        await vi.waitFor(() => expect(fake.onSessionEvent).toHaveBeenCalledTimes(3));
        expect(fake.getEntries).not.toHaveBeenCalled();

        back.resolve();
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalled());
    });

    it("drops the first listener when the second one cannot be opened", async () => {
        // Half a pair is worth less than none: a session whose end nobody hears
        // is a transcript that keeps showing a pi that is gone. The connect
        // machine treats the same failure as a failed handshake, and this hook
        // refuses the read the same way.
        fake.onSessionState.mockImplementation(async () => {
            throw { type: "rpc", message: "the bus refused the listener", error: { kind: "closed" } };
        });
        const { result } = render("main:1");
        subscribed.resolve();

        await waitFor(() => expect(unlistened).toEqual(["event:main:1"]));
        await waitFor(() => expect(result.current.error?.message).toBe("the bus refused the listener"));
        expect(fake.getEntries).not.toHaveBeenCalled();
    });

    it("drops both listeners when the hook goes away", async () => {
        const { unmount } = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(listened).toHaveLength(2));

        unmount();

        await waitFor(() => expect(unlistened).toEqual(["event:main:1", "state:main:1"]));
    });
});

describe("statsRefetchInterval", () => {
    it("stops asking a session whose read failed, and keeps asking otherwise", () => {
        expect(statsRefetchInterval({ state: { status: "error" } })).toBe(false);
        expect(statsRefetchInterval({ state: { status: "success" } })).toBe(30_000);
        expect(statsRefetchInterval({ state: { status: "pending" } })).toBe(30_000);
    });
});
