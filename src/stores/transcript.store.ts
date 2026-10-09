/**
 * The entries of one session, as the events and the snapshot bring them: append-only,
 * except that a hydrate lays a snapshot under what it already holds (the snapshot of
 * `get_entries` is the authority).
 *
 * The store holds what pi wrote and nothing of the view: the path to the leaf and
 * the compaction fold are pure functions, and live in `@/lib/transcript`. It holds
 * **one session**; a second one at the same time needs a store per session.
 *
 * Two of its parts are not entries. `queue_update` reports the messages that wait
 * whole, so the store replaces its lists instead of appending to them, and the
 * shell command of the reader that still runs is a row of the transcript before pi
 * records it as an entry. Both belong to this session and end with it, which is why
 * they are here and not beside the screen.
 */

import { create } from "zustand";
import type { AgentMessage, AssistantMessageEvent, EntriesData, SessionEntry, Usage } from "@/lib/protocol";
import type { JsonValue } from "@/lib/protocol/serde_json/JsonValue";
import {
    applyDelta,
    beginMessage,
    beginRun,
    endCall,
    endMessage,
    markRetrying,
    noRun,
    startCall,
    updateCall,
    type LiveRun,
} from "@/lib/stream";
import type { TranscriptEntries } from "@/lib/transcript";

/** The shell command of the reader that runs right now. */
export interface BashRun {
    /** The command line the reader entered. */
    command: string;
    /** What pi streamed for it so far. */
    output: string;
    /** `!!`: the result stays out of the context of the model. */
    excludeFromContext: boolean;
}

/** The messages that wait for a run, as `queue_update` reports them. */
export interface QueuedMessages {
    /** Messages that interrupt the run at its next step. */
    steering: string[];
    /** Messages that wait for the run to settle. */
    followUp: string[];
}

interface TranscriptStore extends TranscriptEntries {
    /** The leaf the session points at; `null` in a session without entries. */
    leafId: string | null;
    /** The messages that pi holds for after the current turn. */
    queued: QueuedMessages;
    /** The shell command of the reader that runs right now, if one runs. */
    runningBash: BashRun | null;
    /**
     * What the response that streams right now has spent. The usage of a response is
     * written to the session file with its message, so the reads of a session are behind
     * it until the response is over; this is what the ring and the cost follow meanwhile.
     */
    liveUsage: Usage | null;
    /**
     * The messages the run writes right now. A message reaches the transcript file only
     * after the run, so this is the only thing that shows an answer while it arrives.
     */
    live: LiveRun;
    /**
     * The name a row renders under, for an entry that took over a message the run had
     * already drawn: the row keeps the name its live row had, so that a card mid-flight
     * does not start over - neither its clock nor the body the reader opened.
     */
    rowIds: Map<string, string>;
    /** The number the next live row is named with. */
    nextLive: number;
    /** Lays a snapshot of the session under what it already holds. */
    hydrate: (snapshot: EntriesData) => void;
    /** Takes one appended entry; an id that is already there is replaced. */
    appendEntry: (entry: SessionEntry) => void;
    /** Replaces the queued messages; pi reports both lists whole. */
    setQueue: (queued: QueuedMessages) => void;
    /** Takes the usage of the streaming response, which pi reports cumulatively. */
    setLiveUsage: (usage: Usage) => void;
    /** Forgets it: the read that has it in a message carries it from here. */
    clearLiveUsage: () => void;
    /** Opens the live row of a shell command that the reader just started. */
    startBash: (run: { command: string; excludeFromContext: boolean }) => void;
    /** Adds a piece of the output of the running command. */
    appendBash: (delta: string) => void;
    /** Drops the live row; the entry pi recorded carries it from here. */
    finishBash: () => void;
    /** A run of this session began: it has written nothing yet. */
    liveRunStart: () => void;
    /** A message of the run began. */
    liveStart: (message: AgentMessage) => void;
    /** A delta of the message that streams. */
    liveDelta: (event: AssistantMessageEvent) => void;
    /** A message of the run finished; the final message is the authority. */
    liveEnd: (message: AgentMessage) => void;
    /** A tool call started, with the arguments the tool was called with. */
    liveToolStart: (call: { toolCallId: string; args: JsonValue }) => void;
    /** What a tool call streamed, which is its whole output so far. */
    liveToolUpdate: (call: { toolCallId: string; toolName: string; partialResult: JsonValue }) => void;
    /** What a tool call answered. */
    liveToolEnd: (call: { toolCallId: string; toolName: string; result: JsonValue; isError: boolean }) => void;
    /** Pi takes the turn up again: its failure is not the end of the run. */
    liveRetrying: () => void;
    /** Forgets the session, so the next one starts empty. */
    clear: () => void;
}

const noQueue: QueuedMessages = { steering: [], followUp: [] };

/**
 * What makes a message the one a live row stands for. A message carries no id of its
 * own, and its timestamp is the one pi records it with, so the entry and the live row
 * meet on it.
 */
function identity(message: AgentMessage): string {
    return `${message.role}:${message.timestamp}`;
}

/**
 * The run that `entry` is the record of: `null` when the entry records it, and the
 * run itself while the entry is something else.
 */
function supersededRun(running: BashRun | null, entry: SessionEntry): BashRun | null {
    if (running === null) return null;
    if (entry.type !== "message" || entry.message.role !== "bashExecution") return running;
    return entry.message.command === running.command ? null : running;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
    entries: new Map(),
    order: [],
    leafId: null,
    queued: noQueue,
    runningBash: null,
    live: noRun,
    liveUsage: null,
    rowIds: new Map(),
    nextLive: 1,

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

            // A message the run drew is in this snapshot now: the entry carries the truth
            // from here, and the live row that stood for it goes. Its name stays behind, so
            // the row it becomes is the row it was.
            const held = new Map<string, string>();
            for (const entry of entries.values()) {
                if (entry.type === "message") held.set(identity(entry.message), entry.id);
            }
            const rowIds = new Map(state.rowIds);
            const live = state.live.messages.filter((message) => {
                const entryId = held.get(identity(message.message));
                if (entryId === undefined) return true;
                rowIds.set(entryId, message.id);
                return false;
            });

            // The entry of the reader's own shell command is the record of it, whichever
            // read brings it: the live card has nothing left to say.
            let runningBash = state.runningBash;
            for (const entry of entries.values()) runningBash = supersededRun(runningBash, entry);

            // The run keeps the flag it had: the row it just lost is in the read, and the
            // run that wrote it is still the same one.
            return {
                entries,
                order,
                leafId,
                live: { messages: live, working: state.live.working },
                rowIds,
                runningBash,
            };
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
            // The entry of a shell command is the record of the reader's own run, and
            // it supersedes the live card. Pi defers that entry while a run streams
            // (its own `_pendingBashMessages`), so the card stands above the composer
            // until the record it belongs to arrives.
            runningBash: supersededRun(state.runningBash, entry),
        })),

    // The arrays are copied: the payload belongs to the event that carried it.
    setQueue: (queued) => set({ queued: { steering: [...queued.steering], followUp: [...queued.followUp] } }),

    setLiveUsage: (usage) => set({ liveUsage: usage }),

    clearLiveUsage: () => set({ liveUsage: null }),

    startBash: (run) => set({ runningBash: { ...run, output: "" } }),

    // An update without a running command is not this store's: the command may have
    // ended between pi writing the delta and the frontend reading it.
    appendBash: (delta) =>
        set((state) =>
            state.runningBash
                ? { runningBash: { ...state.runningBash, output: state.runningBash.output + delta } }
                : {},
        ),

    finishBash: () => set({ runningBash: null }),

    liveRunStart: () => set((state) => ({ live: beginRun(state.live) })),

    liveStart: (message) =>
        set((state) => ({
            live: beginMessage(state.live, `live-${state.nextLive}`, message),
            nextLive: state.nextLive + 1,
        })),

    liveDelta: (event) => set((state) => ({ live: applyDelta(state.live, event) })),

    liveEnd: (message) => set((state) => ({ live: endMessage(state.live, message) })),

    liveToolStart: (call) => set((state) => ({ live: startCall(state.live, call) })),

    liveToolUpdate: (call) => set((state) => ({ live: updateCall(state.live, call) })),

    liveToolEnd: (call) => set((state) => ({ live: endCall(state.live, call) })),

    liveRetrying: () => set((state) => ({ live: markRetrying(state.live) })),

    clear: () =>
        set({
            entries: new Map(),
            order: [],
            leafId: null,
            queued: noQueue,
            runningBash: null,
            live: noRun,
            liveUsage: null,
            rowIds: new Map(),
            nextLive: 1,
        }),
}));
