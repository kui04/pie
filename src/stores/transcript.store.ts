/**
 * The entries of one session, as the events and the snapshot bring them.
 *
 * The store is append-only, except that a hydrate lays a snapshot under what it
 * already holds: the snapshot of `get_entries` is the authority, and a record
 * that arrived before it is in it (or was summarized away by a compaction, which
 * the fold below handles).
 *
 * The store holds entries exactly as pi wrote them. The view of the transcript is
 * not the entry set: it is the path from the root to the leaf, with the latest
 * compaction folded in. That fold is a pure function of the entries, so it is
 * here as functions over the stored data and **not** as state that a second
 * writer could disagree with.
 *
 * The store holds **one session**: the product shows one at a time, and the
 * hook that feeds this store clears it when the session changes. A second
 * caller for another session at the same time would write into the same entries,
 * so that day needs one store of these per session.
 *
 * Both functions mirror pi at the pinned release (`core/session-manager.ts`:
 * `buildSessionPath`, `buildContextEntries`); the tests beside this file hold the
 * cases of that algorithm.
 */

import { create } from "zustand";
import type { EntriesData, SessionEntry } from "@/lib/protocol";

/** The entries of a session, in the shape the fold reads. */
export interface TranscriptEntries {
    /** Every entry, by id. */
    entries: Map<string, SessionEntry>;
    /** The ids in the order pi wrote them: the file order of the snapshot. */
    order: string[];
}

interface TranscriptStore extends TranscriptEntries {
    /** The leaf the session points at; `null` in a session without entries. */
    leafId: string | null;
    /** Lays a snapshot of the session under what it already holds. */
    hydrate: (snapshot: EntriesData) => void;
    /** Takes one appended entry; an id that is already there is replaced. */
    appendEntry: (entry: SessionEntry) => void;
    /** Forgets the session, so the next one starts empty. */
    clear: () => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
    entries: new Map(),
    order: [],
    leafId: null,

    hydrate: (snapshot) =>
        set((state) => {
            const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
            const order = snapshot.entries.map((entry) => entry.id);
            // What this snapshot brought, and not what the store holds: the two
            // questions below are both about the snapshot, and an id the store
            // kept from an earlier read is not an id of this one.
            const fromSnapshot = new Set(order);
            // An entry that arrived while the read was in flight is not in the
            // snapshot. The read and the use of it cannot be one step, so what
            // the events brought in after the read stands, in the file order of
            // the ids that came in.
            for (const id of state.order) {
                const entry = state.entries.get(id);
                if (entry && !fromSnapshot.has(id)) {
                    entries.set(id, entry);
                    order.push(id);
                }
            }
            // The leaf of the snapshot is where pi pointed when it answered.
            // Only an entry that the snapshot does not carry is younger than that
            // answer - the leaf of an earlier read is not, and a later snapshot
            // moves past it.
            const leafId = state.leafId && !fromSnapshot.has(state.leafId) ? state.leafId : snapshot.leafId;
            return { entries, order, leafId };
        }),

    // Pi advances its leaf to every entry it appends
    // (`_appendEntry` of `core/session-manager.ts`). The transcript follows the
    // same point, or it would keep showing the leaf of the snapshot.
    //
    // Both of these copy what the state held, so one append costs the size of
    // the transcript: fine for the hundreds of entries of a session, and a thing
    // to measure before a run of tens of thousands streams into it. The snapshot
    // and the entries are the whole of what a screen renders, so the milestone
    // that renders them memoizes the fold over this state rather than recomputing
    // it per event.
    appendEntry: (entry) =>
        set((state) => ({
            entries: new Map(state.entries).set(entry.id, entry),
            // `has` and not `includes`: the map is the index the fold uses, and
            // it answers for one id without walking anything.
            order: state.entries.has(entry.id) ? state.order : [...state.order, entry.id],
            leafId: entry.id,
        })),

    clear: () => set({ entries: new Map(), order: [], leafId: null }),
}));

/**
 * The path from the root to the leaf, following `parentId`.
 *
 * A `null` leaf is an empty session, so the answer is empty - pi's rule, and
 * not "the last entry". A leaf id that no entry carries falls back to the last
 * entry of the file order, and a parent that is missing ends the walk there.
 */
export function sessionPath(store: TranscriptEntries, leafId: string | null): SessionEntry[] {
    if (leafId === null) return [];

    const last = store.order.length > 0 ? store.entries.get(store.order[store.order.length - 1]) : undefined;
    const leaf = (leafId ? store.entries.get(leafId) : undefined) ?? last;
    if (!leaf) return [];

    const path: SessionEntry[] = [];
    let current: SessionEntry | undefined = leaf;
    while (current) {
        path.push(current);
        current = current.parentId ? store.entries.get(current.parentId) : undefined;
    }
    return path.reverse();
}

/**
 * The entries of the transcript: the path to the leaf with the last compaction
 * folded in.
 *
 * Without a compaction the path is the answer. With one, the answer starts at
 * that compaction entry (its summary stands for what it replaced), keeps the
 * entries from `firstKeptEntryId` on, drops the system messages in that range
 * (a system message belongs to the context, not to the transcript), and keeps
 * everything the compaction came after.
 */
export function contextEntries(store: TranscriptEntries, leafId: string | null): SessionEntry[] {
    const path = sessionPath(store, leafId);

    let compaction: Extract<SessionEntry, { type: "compaction" }> | undefined;
    for (const entry of path) {
        if (entry.type === "compaction") compaction = entry;
    }
    if (!compaction) return path;

    const at = path.findIndex((entry) => entry.id === compaction.id);
    if (at < 0) return path;

    const context: SessionEntry[] = [compaction];
    let fromFirstKept = false;
    for (let index = 0; index < at; index += 1) {
        const entry = path[index];
        if (entry.id === compaction.firstKeptEntryId) fromFirstKept = true;
        if (fromFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
            context.push(entry);
        }
    }
    context.push(...path.slice(at + 1));
    return context;
}
