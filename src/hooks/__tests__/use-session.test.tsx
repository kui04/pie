import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { EntriesData, Event, SessionEntry, SessionState, SessionStats } from "@/lib/protocol";
import { liveRows } from "@/lib/stream";
import { statsRefetchInterval, useSession } from "@/hooks/use-session";
import { queryDefaults } from "@/lib/query";
import { assistant, usage } from "@/preview/fixtures";
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
    switchSession: vi.fn<(session: string, path: string) => Promise<{ cancelled: boolean }>>(),
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
        fake.switchSession.mockReset().mockResolvedValue({ cancelled: false });
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

    it("starts from nothing when the mount is another session", async () => {
        // The entries of the last session are not the entries of this one, and a
        // reader must not see them for a frame: another session is another mount
        // (`ChatScreen` keys it), and the store is cleared before it draws.
        const first = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));
        first.unmount();

        subscribed = deferred();
        render("main:2");

        expect(useTranscriptStore.getState().order).toEqual([]);
        subscribed.resolve();
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
        // failure belongs to that attempt, not to the name of the session - and
        // the later visit is a later mount of its own, which is how a screen
        // shows a session a second time.
        fake.onSessionEvent.mockImplementationOnce(async () => {
            throw { type: "rpc", message: "the bus refused the listener", error: { kind: "closed" } };
        });
        const first = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(first.result.current.error?.message).toBe("the bus refused the listener"));
        first.unmount();

        subscribed = deferred();
        const again = render("main:1");
        subscribed.resolve();

        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledWith("main:1"));
        expect(again.result.current.error).toBeNull();
    });

    it("refuses a session that arrives in the mount of another", async () => {
        // The chart of a session is built once for the mount, so a screen that
        // changes the name under it would read the new session while it listens
        // to the one before. That is a screen that lost its `key`, and it is a
        // mistake worth hearing about.
        subscribed.resolve();
        const mounted = render("main:1");
        await waitFor(() => expect(mounted.result.current.listening).toBe(true));

        expect(() => mounted.rerender({ id: "main:2" })).toThrow(/one session/);
    });

    it("drops the queue when the listeners open again, and keeps the run on screen", async () => {
        // A reopen covers a time when nothing listened. The reads that follow carry the
        // entries, and no read carries the queue - so the queue goes. What the run drew
        // and the phase it is in stay: those rows are still the run's, the deltas that
        // keep arriving land in them, and the read of the state settles the phase.
        // The pi of this session is still streaming, which is what the read after the
        // reopen answers with.
        fake.getState.mockResolvedValue({ isStreaming: true } as SessionState);
        const mounted = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(fake.onSessionEvent).toHaveBeenCalled());

        publish?.({ type: "queue_update", steering: ["go on"], followUp: [] });
        publish?.({ type: "agent_start" });
        publish?.({ type: "message_start", message: assistant([], { stopReason: "pending" as const }) });
        await waitFor(() => expect(useTranscriptStore.getState().queued.steering).toEqual(["go on"]));
        publish?.({
            type: "message_start",
            message: { ...assistant([], { stopReason: "pending" as const }), timestamp: 11 },
        });
        await waitFor(() => expect(mounted.result.current.phase).toBe("working"));

        subscribed = deferred();
        mounted.result.current.reopen();
        subscribed.resolve();

        await waitFor(() => expect(useTranscriptStore.getState().queued.steering).toEqual([]));
        // The rows of the run and its phase are the run's still: the deltas that keep
        // arriving land in them, and the read that follows agrees that it streams.
        expect(useTranscriptStore.getState().live.messages).toHaveLength(2);
        await waitFor(() => expect(mounted.result.current.phase).toBe("working"));
    });

    it("refuses a switch while the feed is not live, and says so instead of asking", async () => {
        // The chart accepts a switch only from a live feed: a screen that never attached
        // has no conversation to leave. Asking Rust anyway would switch the session behind
        // the chart's back and leave the store with the old one.
        fake.onSessionEvent.mockImplementation(async () => {
            await subscribed.promise;
            return () => undefined;
        });
        const mounted = render("main:1");
        expect(mounted.result.current.listening).toBe(false);

        await mounted.result.current.switchTo("/tmp/other.jsonl");
        expect(fake.switchSession).not.toHaveBeenCalled();
    });

    it("replaces the conversation that was left when the answer arrives", async () => {
        // The store holds the conversation that is leaving until the read of the new one
        // answers - clearing at the switch would empty the page that is still fading out -
        // and that answer is written in their place: they are another conversation, and
        // the entries of one never sit in the transcript of another.
        const mounted = render("main:1");
        subscribed.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["a"]));

        const later = deferred();
        fake.getEntries.mockImplementation(async () => {
            await later.promise;
            return snapshot([userMessage("b", null)], "b");
        });

        await mounted.result.current.switchTo("/tmp/other.jsonl");

        expect(fake.switchSession).toHaveBeenCalledWith("main:1", "/tmp/other.jsonl");
        expect(useTranscriptStore.getState().order).toEqual(["a"]);

        later.resolve();
        await waitFor(() => expect(useTranscriptStore.getState().order).toEqual(["b"]));
        expect([...useTranscriptStore.getState().entries.keys()]).toEqual(["b"]);
        expect(useTranscriptStore.getState().leafId).toBe("b");
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

    it("reads nothing while the listeners of its mount are still opening", async () => {
        // The listeners of this mount are the only ones this actor has: the read
        // waits for them, and no read of another mount can answer for them, because
        // another mount is another actor.
        const mounted = render("main:1");
        await vi.waitFor(() => expect(fake.onSessionEvent).toHaveBeenCalledTimes(1));
        expect(fake.getEntries).not.toHaveBeenCalled();

        subscribed.resolve();
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledWith("main:1"));
        expect(useTranscriptStore.getState().order).toEqual(["a"]);
        expect(mounted.result.current.listening).toBe(true);
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

describe("the run a session streams", () => {
    let client: QueryClient;
    let subscribed: ReturnType<typeof deferred>;

    beforeEach(() => {
        useTranscriptStore.getState().clear();
        publish = undefined;
        listened = [];
        unlistened = [];
        subscribed = deferred();
        toast.dismiss();
        vi.spyOn(toast, "warning");
        vi.spyOn(toast, "error");
        vi.spyOn(toast, "dismiss");

        fake.getState.mockReset().mockResolvedValue({ isStreaming: true } as SessionState);
        fake.getSessionStats.mockReset().mockResolvedValue({} as SessionStats);
        fake.getEntries.mockReset().mockResolvedValue(snapshot([], null));
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

        client = new QueryClient(queryDefaults);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function render() {
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        return renderHook(() => useSession("main:1"), { wrapper });
    }

    /** A run whose listeners are open and whose first read landed. */
    async function open() {
        const mounted = render();
        subscribed.resolve();
        await waitFor(() => expect(mounted.result.current.listening).toBe(true));
        return mounted;
    }

    /** The answer of the model, streaming. */
    function assistantRun(timestamp: number) {
        return { ...assistant([], { stopReason: "pending" }), timestamp };
    }

    it("drews the answer as its deltas arrive", async () => {
        await open();

        publish?.({ type: "message_start", message: assistantRun(10) });
        publish?.({
            type: "message_update",
            usage: usage(),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "an ans" },
        });
        publish?.({
            type: "message_update",
            usage: usage(),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wer" },
        });

        await waitFor(() =>
            expect(liveRows(useTranscriptStore.getState().live)).toMatchObject([
                { kind: "assistant", message: { content: [{ type: "text", text: "an answer" }] } },
            ]),
        );
    });

    it("settles the row when the message ends", async () => {
        await open();
        publish?.({ type: "message_start", message: assistantRun(10) });
        publish?.({
            type: "message_update",
            usage: usage(),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" },
        });

        const final = {
            ...assistantRun(10),
            content: [{ type: "text" as const, text: "the whole answer" }],
            stopReason: "stop" as const,
        };
        publish?.({ type: "message_end", message: final });

        await waitFor(() =>
            expect(liveRows(useTranscriptStore.getState().live)).toMatchObject([
                {
                    kind: "assistant",
                    message: { content: [{ type: "text", text: "the whole answer" }], stopReason: "stop" },
                },
            ]),
        );
    });

    it("runs a tool call and settles it with what it answered", async () => {
        await open();
        publish?.({
            type: "message_start",
            message: {
                ...assistantRun(10),
                content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
            },
        });

        publish?.({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
        publish?.({
            type: "tool_execution_update",
            toolCallId: "c1",
            toolName: "bash",
            args: {},
            partialResult: { content: [{ type: "text", text: "one\n" }] },
        });

        await waitFor(() => {
            const [row] = liveRows(useTranscriptStore.getState().live);
            const call = (row as Extract<typeof row, { kind: "assistant" }>).live?.calls.get("c1");
            expect(call).toMatchObject({ running: true });
            expect(call?.result?.content).toEqual([{ type: "text", text: "one\n" }]);
        });

        publish?.({
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "bash",
            result: { content: [] },
            isError: false,
        });

        await waitFor(() => {
            const [row] = liveRows(useTranscriptStore.getState().live);
            expect((row as Extract<typeof row, { kind: "assistant" }>).live?.calls.get("c1")?.running).toBe(false);
        });
    });

    it("applies the deltas that came before a tool call first", async () => {
        // The frame holds the deltas of one answer together; a record that is not a
        // delta must not read the parts before the text they belong to arrived.
        await open();
        publish?.({ type: "message_start", message: assistantRun(10) });
        publish?.({
            type: "message_update",
            usage: usage(),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" },
        });
        publish?.({ type: "message_start", message: { role: "user", content: "and now?", timestamp: 11 } });

        await waitFor(() =>
            expect(liveRows(useTranscriptStore.getState().live)).toMatchObject([
                { kind: "assistant", message: { content: [{ type: "text", text: "one" }] } },
                { kind: "user" },
            ]),
        );
    });

    it("holds a failure for the read when pi runs the turn again", async () => {
        await open();
        const failed = {
            ...assistantRun(10),
            content: [{ type: "text" as const, text: "overloaded" }],
            stopReason: "error" as const,
        };
        publish?.({ type: "message_start", message: assistantRun(10) });
        publish?.({ type: "message_end", message: failed });

        publish?.({ type: "agent_end", messages: [failed], willRetry: true });

        await waitFor(() =>
            expect(liveRows(useTranscriptStore.getState().live)[0]).toMatchObject({ live: { retrying: true } }),
        );
    });

    it("follows the usage of the response that streams", async () => {
        await open();
        publish?.({ type: "message_start", message: assistantRun(10) });

        publish?.({
            type: "message_update",
            usage: usage({
                totalTokens: 4200,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
            }),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "an answer" },
        });

        await waitFor(() => expect(useTranscriptStore.getState().liveUsage?.usage.totalTokens).toBe(4200));

        // The read of the usage that follows a finished response carries it as a message,
        // so the increment goes: it would be the same tokens twice.
        fake.getSessionStats.mockResolvedValue({} as SessionStats);
        publish?.({ type: "message_end", message: assistantRun(10) });

        await waitFor(() => expect(useTranscriptStore.getState().liveUsage).toBeNull());
    });

    it("says what a summarization retry is doing, and takes the words back when it works", async () => {
        await open();

        publish?.({
            type: "summarization_retry_scheduled",
            attempt: 1,
            maxAttempts: 2,
            delayMs: 100,
            errorMessage: "timeout",
        });
        expect(toast.warning).toHaveBeenCalledWith("Pi is retrying the summary", {
            id: "session-summary-retry",
            description: "timeout - attempt 1 of 2",
        });

        // The attempt itself says what pi works on, and which attempt it is.
        publish?.({ type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" });
        expect(toast.warning).toHaveBeenCalledWith("Pi is retrying the summary", {
            id: "session-summary-retry",
            description: "Compacting the context - attempt 1 of 2",
        });

        publish?.({ type: "summarization_retry_finished" });
        expect(toast.dismiss).toHaveBeenCalledWith("session-summary-retry");
    });

    it("names a branch summary as what it retries", async () => {
        await open();

        publish?.({
            type: "summarization_retry_scheduled",
            attempt: 2,
            maxAttempts: 2,
            delayMs: 100,
            errorMessage: "timeout",
        });
        publish?.({ type: "summarization_retry_attempt_start", source: "branchSummary" });

        expect(toast.warning).toHaveBeenCalledWith("Pi is retrying the summary", {
            id: "session-summary-retry",
            description: "Writing a branch summary - attempt 2 of 2",
        });
    });

    it("reads the session again when the run is over", async () => {
        const mounted = await open();
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledTimes(1));

        publish?.({ type: "agent_settled" });

        await waitFor(() => expect(fake.getEntries).toHaveBeenCalledTimes(2));
        expect(mounted.result.current.phase).toBe("idle");
    });

    it("says what a retry is doing, and takes the words back when the retry works", async () => {
        await open();

        publish?.({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "overloaded" });

        expect(toast.warning).toHaveBeenCalledWith("Pi is retrying the request", {
            id: "session-retry",
            description: "overloaded - attempt 1 of 3",
        });

        publish?.({ type: "auto_retry_end", success: true, attempt: 1 });
        expect(toast.dismiss).toHaveBeenCalledWith("session-retry");
    });

    it("says when pi gave up", async () => {
        await open();

        publish?.({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "overloaded" });
        publish?.({ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" });

        expect(toast.error).toHaveBeenCalledWith("Pi gave up on the request", {
            id: "session-retry",
            description: "overloaded",
        });
    });

    it("reads the state again when the last record of a compaction lands", async () => {
        await open();
        fake.getState.mockClear();

        publish?.({ type: "compaction_end", reason: "threshold", result: null, aborted: false, willRetry: false });

        await waitFor(() => expect(fake.getState).toHaveBeenCalled());
    });

    it("opens the feed when React mounts the screen twice over", async () => {
        // StrictMode starts an effect, stops it and starts it again. The chart is
        // what the whole screen waits on, so an actor that a second start leaves
        // closed is a screen that never opens a session (`useActorRef` owns the
        // lifecycle for this reason).
        subscribed.resolve();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <StrictMode>
                <QueryClientProvider client={client}>{children}</QueryClientProvider>
            </StrictMode>
        );
        const mounted = renderHook(() => useSession("main:1"), { wrapper });

        await waitFor(() => expect(mounted.result.current.listening).toBe(true));
        await waitFor(() => expect(fake.getEntries).toHaveBeenCalled());
    });
});

describe("statsRefetchInterval", () => {
    it("stops asking a session whose read failed, and keeps asking otherwise", () => {
        expect(statsRefetchInterval({ state: { status: "error" } })).toBe(false);
        expect(statsRefetchInterval({ state: { status: "success" } })).toBe(30_000);
        expect(statsRefetchInterval({ state: { status: "pending" } })).toBe(30_000);
    });
});
