/**
 * The entries of one session, as the events and the snapshot bring them: append-only,
 * except that a hydrate lays a snapshot under what it already holds (the snapshot of
 * `get_entries` is the authority).
 *
 * The store holds entries as pi wrote them and nothing of the view: the path to the
 * leaf and the compaction fold are pure functions, and live in `@/lib/transcript`.
 * It holds **one session**; a second one at the same time needs a store per session.
 */

import { create } from "zustand";
import type { EntriesData, SessionEntry } from "@/lib/protocol";
import type { TranscriptEntries } from "@/lib/transcript";

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
            // Both questions below are about the snapshot, not the store: an id kept
            // from an earlier read is not an id of this one.
            const fromSnapshot = new Set(order);
            // An entry that arrived while the read was in flight is in neither the
            // snapshot nor its order, so it stands, in the order it came in.
            for (const id of state.order) {
                const entry = state.entries.get(id);
                if (entry && !fromSnapshot.has(id)) {
                    entries.set(id, entry);
                    order.push(id);
                }
            }
            // Only an entry the snapshot does not carry is younger than its leaf; an
            // earlier read's leaf is not, and a later snapshot moves past it.
            const leafId = state.leafId && !fromSnapshot.has(state.leafId) ? state.leafId : snapshot.leafId;
            return { entries, order, leafId };
        }),

    // Pi advances its leaf to every entry it appends (`_appendEntry` of
    // `core/session-manager.ts`), and the transcript follows the same point.
    //
    // Both copy the state they held, so one append costs the size of the transcript:
    // fine for hundreds of entries, a thing to measure before tens of thousands.
    appendEntry: (entry) =>
        set((state) => ({
            entries: new Map(state.entries).set(entry.id, entry),
            // `has` and not `includes`: the map is the index the fold uses.
            order: state.entries.has(entry.id) ? state.order : [...state.order, entry.id],
            leafId: entry.id,
        })),

    clear: () => set({ entries: new Map(), order: [], leafId: null }),
}));
