import { beforeEach, describe, expect, it } from "vitest";
import type { EntriesData, SessionEntry } from "@/lib/protocol";
import { contextEntries, sessionPath, type TranscriptEntries } from "@/lib/transcript";
import { useTranscriptStore } from "@/stores/transcript.store";
import { bashExecution, chain, messageEntry } from "@/preview/fixtures";

const AT = "2026-10-05T00:00:00.000Z";

function userMessage(id: string, parentId: string | null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: AT,
        message: { role: "user", content: `text of ${id}`, timestamp: 0 },
    };
}

function systemMessage(id: string, parentId: string | null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: AT,
        message: { role: "system", content: `rules of ${id}`, timestamp: 0 },
    };
}

function compaction(id: string, parentId: string | null, firstKeptEntryId: string): SessionEntry {
    return {
        type: "compaction",
        id,
        parentId,
        timestamp: AT,
        summary: `summary of ${id}`,
        firstKeptEntryId,
        tokensBefore: 1000,
    };
}

/** A store's worth of entries, in the file order they are given in. */
function transcript(entries: SessionEntry[]): TranscriptEntries {
    return { entries: new Map(entries.map((entry) => [entry.id, entry])), order: entries.map((entry) => entry.id) };
}

/** The ids of the entries a function answered with. */
function ids(entries: SessionEntry[]): string[] {
    return entries.map((entry) => entry.id);
}

describe("sessionPath", () => {
    it("answers with nothing when pi points at no leaf", () => {
        // Pi's rule, and not an accident: a snapshot without a leaf is a session
        // without a transcript, even when it carries entries. The fold follows it.
        const store = transcript([userMessage("a", null)]);

        expect(contextEntries(store, null)).toEqual([]);
    });

    it("answers with nothing for a session that points at no leaf", () => {
        const store = transcript([userMessage("a", null)]);

        expect(sessionPath(store, null)).toEqual([]);
    });

    it("answers with nothing for a store without entries", () => {
        expect(sessionPath(transcript([]), "gone")).toEqual([]);
    });

    it("follows the path from the root to the leaf", () => {
        const store = transcript([userMessage("a", null), userMessage("b", "a"), userMessage("c", "b")]);

        expect(ids(sessionPath(store, "c"))).toEqual(["a", "b", "c"]);
    });

    it("takes the last entry of the file order when the leaf is not there", () => {
        // A leaf id that no entry carries: pi falls back to the last entry.
        const store = transcript([userMessage("a", null), userMessage("b", "a")]);

        expect(ids(sessionPath(store, "missing"))).toEqual(["a", "b"]);
    });

    it("keeps the branch of the leaf and leaves the other one out", () => {
        // Root a, then two children; the leaf sits on the second child's line.
        const store = transcript([
            userMessage("a", null),
            userMessage("b", "a"),
            userMessage("c", "a"),
            userMessage("d", "c"),
        ]);

        expect(ids(sessionPath(store, "d"))).toEqual(["a", "c", "d"]);
    });

    it("ends the walk at a parent that is not in the entries", () => {
        const store = transcript([userMessage("a", null), userMessage("b", "gone"), userMessage("c", "b")]);

        expect(ids(sessionPath(store, "c"))).toEqual(["b", "c"]);
    });
});

describe("contextEntries", () => {
    it("answers with the path when the session was never compacted", () => {
        const store = transcript([systemMessage("s", null), userMessage("a", "s")]);

        expect(ids(contextEntries(store, "a"))).toEqual(["s", "a"]);
    });

    it("folds the entries a compaction summarized away", () => {
        // a, b, c are summarized; the compaction keeps c and everything after it.
        const store = transcript([
            userMessage("a", null),
            userMessage("b", "a"),
            userMessage("c", "b"),
            compaction("k", "c", "c"),
            userMessage("d", "k"),
        ]);

        expect(ids(contextEntries(store, "d"))).toEqual(["k", "c", "d"]);
    });

    it("folds only the last of two compactions", () => {
        const store = transcript([
            userMessage("a", null),
            compaction("k1", "a", "a"),
            userMessage("b", "k1"),
            compaction("k2", "b", "b"),
            userMessage("c", "k2"),
        ]);

        expect(ids(contextEntries(store, "c"))).toEqual(["k2", "b", "c"]);
    });

    it("drops the system messages of the kept range and keeps the later ones", () => {
        // `s1` sits in the range the compaction kept, `s2` came after it.
        const store = transcript([
            userMessage("a", null),
            systemMessage("s1", "a"),
            compaction("k", "s1", "a"),
            systemMessage("s2", "k"),
            userMessage("b", "s2"),
        ]);

        expect(ids(contextEntries(store, "b"))).toEqual(["k", "a", "s2", "b"]);
    });

    it("keeps nothing of the range when the compaction names another entry", () => {
        // `firstKeptEntryId` that is not on the path before the compaction: the
        // summary stands for the whole range.
        const store = transcript([
            userMessage("a", null),
            userMessage("b", "a"),
            compaction("k", "b", "gone"),
            userMessage("c", "k"),
        ]);

        expect(ids(contextEntries(store, "c"))).toEqual(["k", "c"]);
    });

    it("leaves the entries it was given alone", () => {
        const store = transcript([userMessage("a", null), compaction("k", "a", "a"), userMessage("b", "k")]);
        const before = { order: [...store.order], size: store.entries.size };

        contextEntries(store, "b");

        expect(store.order).toEqual(before.order);
        expect(store.entries.size).toBe(before.size);
    });
});

describe("the transcript store", () => {
    beforeEach(() => {
        useTranscriptStore.getState().clear();
    });

    it("takes the snapshot as the whole of what it holds", () => {
        const snapshot: EntriesData = { entries: [userMessage("a", null), userMessage("b", "a")], leafId: "b" };

        useTranscriptStore.getState().hydrate(snapshot);

        const state = useTranscriptStore.getState();
        expect(state.order).toEqual(["a", "b"]);
        expect(state.leafId).toBe("b");
        expect(ids(contextEntries(state, state.leafId))).toEqual(["a", "b"]);
    });

    it("advances the leaf with every entry it takes", () => {
        // Pi points at what it just appended; a transcript that kept the leaf of
        // the snapshot would stop following the run.
        useTranscriptStore.getState().hydrate({ entries: [userMessage("a", null)], leafId: "a" });

        useTranscriptStore.getState().appendEntry(userMessage("b", "a"));

        expect(useTranscriptStore.getState().leafId).toBe("b");
        expect(ids(contextEntries(useTranscriptStore.getState(), "b"))).toEqual(["a", "b"]);
    });

    it("lets a newer snapshot move the leaf past the one it already had", () => {
        // A second read of one session - a refetch - answers with a leaf that pi
        // has moved on. The leaf the store held came from the read before it and
        // it is in the snapshot as well, so it is not newer: the snapshot wins.
        // Only an entry that the snapshot does *not* carry is younger than it.
        useTranscriptStore.getState().hydrate({ entries: [userMessage("a", null)], leafId: "a" });

        useTranscriptStore.getState().hydrate({
            entries: [userMessage("a", null), userMessage("b", "a")],
            leafId: "b",
        });

        const state = useTranscriptStore.getState();
        expect(state.leafId).toBe("b");
        expect(ids(contextEntries(state, state.leafId))).toEqual(["a", "b"]);
    });

    it("keeps an entry that arrived while the read was in flight", () => {
        // The read and the use of its answer cannot be one step. An entry that
        // came in between is in neither the snapshot nor the events' own order,
        // and it must not be dropped for it.
        useTranscriptStore.getState().hydrate({ entries: [], leafId: null });
        useTranscriptStore.getState().appendEntry(userMessage("late", "a"));

        useTranscriptStore.getState().hydrate({ entries: [userMessage("a", null)], leafId: "a" });

        const state = useTranscriptStore.getState();
        expect(state.order).toEqual(["a", "late"]);
        expect(state.leafId).toBe("late");
        expect(ids(contextEntries(state, state.leafId))).toEqual(["a", "late"]);
    });

    it("replaces an entry it already has instead of writing it twice", () => {
        const entry = userMessage("a", null);
        useTranscriptStore.getState().hydrate({ entries: [entry], leafId: "a" });

        useTranscriptStore.getState().appendEntry(userMessage("a", null));

        expect(useTranscriptStore.getState().order).toEqual(["a"]);
    });

    it("forgets the entries, the queue and the running command when it is cleared", () => {
        useTranscriptStore.getState().hydrate({ entries: [userMessage("a", null)], leafId: "a" });
        useTranscriptStore.getState().setQueue({ steering: ["one"], followUp: ["two"] });
        useTranscriptStore.getState().startBash({ command: "ls", excludeFromContext: false });

        useTranscriptStore.getState().clear();

        const state = useTranscriptStore.getState();
        expect(state.order).toEqual([]);
        expect(state.leafId).toBeNull();
        expect(state.queued).toEqual({ steering: [], followUp: [] });
        expect(state.runningBash).toBeNull();
    });

    it("replaces the queued messages whole, as pi reports them", () => {
        useTranscriptStore.getState().setQueue({ steering: ["one", "two"], followUp: ["three"] });
        expect(useTranscriptStore.getState().queued).toEqual({ steering: ["one", "two"], followUp: ["three"] });

        useTranscriptStore.getState().setQueue({ steering: [], followUp: [] });
        expect(useTranscriptStore.getState().queued).toEqual({ steering: [], followUp: [] });
    });

    it("copies the queue it was given", () => {
        // The payload belongs to the event that carried it; a later event must not
        // reach into what the store holds.
        const steering = ["one"];

        useTranscriptStore.getState().setQueue({ steering, followUp: [] });
        steering.push("two");

        expect(useTranscriptStore.getState().queued.steering).toEqual(["one"]);
    });

    it("gathers the output of the shell command that runs", () => {
        useTranscriptStore.getState().startBash({ command: "ls", excludeFromContext: false });
        useTranscriptStore.getState().appendBash("one\n");
        useTranscriptStore.getState().appendBash("two\n");

        expect(useTranscriptStore.getState().runningBash).toEqual({
            command: "ls",
            output: "one\ntwo\n",
            excludeFromContext: false,
        });
    });

    it("ignores output that arrives without a command that runs", () => {
        // Pi can write a delta that this side reads after the command ended.
        useTranscriptStore.getState().appendBash("late");

        expect(useTranscriptStore.getState().runningBash).toBeNull();
    });

    it("drops the live row when pi recorded the command", () => {
        useTranscriptStore.getState().startBash({ command: "ls", excludeFromContext: true });

        useTranscriptStore.getState().finishBash();

        expect(useTranscriptStore.getState().runningBash).toBeNull();
    });

    it("takes the live card down with the entry of its run", () => {
        // Pi defers the entry while a run streams; the card stands above the composer
        // until the record it belongs to arrives, and then the record supersedes it.
        useTranscriptStore.getState().startBash({ command: "ls", excludeFromContext: false });

        const [entry] = chain(messageEntry(bashExecution("ls", "one\n")));
        useTranscriptStore.getState().appendEntry(entry);

        expect(useTranscriptStore.getState().runningBash).toBeNull();
    });

    it("keeps the live card when another command's entry arrives", () => {
        useTranscriptStore.getState().startBash({ command: "sleep 60", excludeFromContext: false });

        const [entry] = chain(messageEntry(bashExecution("ls", "one\n")));
        useTranscriptStore.getState().appendEntry(entry);

        expect(useTranscriptStore.getState().runningBash).toMatchObject({ command: "sleep 60" });
    });
});
