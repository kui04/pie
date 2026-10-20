/**
 * What the records of one session wrote, in the shape the machine holds it
 * (`machines/session.machine.ts`), and the view the fold reads: a base read of the
 * conversation plus the entries that arrived after it.
 *
 * Two rules of the wire shape this (`lib/stream.ts`, `lib/transcript.ts`):
 *
 * - A read of `get_entries` is the authority for every entry it carries; the entries
 *   that arrive as `entry_appended` records afterwards are the overlay. Pi's files are
 *   append-only (`session-manager.ts` of the pin), so an overlay entry a fresh answer
 *   does not carry was appended after the read request.
 * - A message carries no id of its own, so a live row and its entry meet on the
 *   timestamp pi records both with, paired in order.
 *
 * Nothing here reaches React or Rust: the machine calls these, and a test holds them
 * without a DOM.
 */

import type {
    AgentMessage,
    AssistantMessageEvent,
    EntriesData,
    JsonValue,
    SessionEntry,
    Usage,
} from "@/lib/rpc-protocol";
import {
    applyDelta,
    beginMessage,
    endCall,
    endMessage,
    markRetrying,
    noRun,
    startCall,
    updateCall,
    type LiveRun,
    type QueuedMessages,
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

/** The usage of the response that streams, and the live row it belongs to. */
export interface LiveUsage {
    /** Cumulative, as `message_update` reports it. */
    usage: Usage;
    /** The id of the live message the response is written into. */
    liveId: string;
    /** When the increment was last written, which orders it against a stats answer. */
    at: number;
}

/** The entries that arrived as records since a base read. */
export interface Overlay {
    /** The entries, by id. It can carry an id that the base also carries (delivery order). */
    entries: Map<string, SessionEntry>;
    /** The ids in the order they were appended. */
    order: string[];
    /** The newest appended entry; `null` when no entry was appended. */
    leaf: string | null;
}

/** Everything the records wrote, as the machine holds it. */
export interface StreamState {
    overlay: Overlay;
    live: LiveRun;
    queued: QueuedMessages;
    /**
     * The name a row renders under, for an entry that took over a message the run had
     * already drawn: the row keeps the name its live row had, so a card mid-flight does
     * not start over - neither its clock nor the body the reader opened.
     */
    rowIds: Map<string, string>;
    /** The number the next live row is named with. */
    nextLive: number;
    bash: BashRun | null;
    usage: LiveUsage | null;
}

/** The messages that wait for a run, empty. */
export const noQueue: QueuedMessages = { steering: [], followUp: [] };

/** A stream that wrote nothing yet. */
export function emptyStream(): StreamState {
    return {
        overlay: { entries: new Map(), order: [], leaf: null },
        live: noRun,
        queued: noQueue,
        rowIds: new Map(),
        nextLive: 1,
        bash: null,
        usage: null,
    };
}

/**
 * What makes a message the one a live row stands for. A message carries no id of its
 * own, and its timestamp is the one pi records it with, so the entry and the live row
 * meet on it.
 */
export function identity(message: AgentMessage): string {
    return `${message.role}:${message.timestamp}`;
}

/** The transcript the fold reads: the base, then the overlay entries whose id the base does not carry. */
export interface MergedTranscript extends TranscriptEntries {
    /** The leaf the fold walks: the overlay leaf, or the base's when the base carries it. */
    leaf: string | null;
}

export function mergedTranscript(base: EntriesData | null, overlay: Overlay): MergedTranscript {
    const entries = new Map<string, SessionEntry>();
    const order: string[] = [];
    let carriesLeaf = false;
    for (const entry of base?.entries ?? []) {
        entries.set(entry.id, entry);
        order.push(entry.id);
        if (entry.id === overlay.leaf) carriesLeaf = true;
    }
    for (const id of overlay.order) {
        if (entries.has(id)) continue;
        const entry = overlay.entries.get(id);
        if (entry) {
            entries.set(id, entry);
            order.push(id);
        }
    }
    // An overlay leaf the base carries is not newer than the base: the base leaf is.
    // An overlay leaf whose parent chain does not reach a root is a branch the
    // transcript cannot walk (an extension record can point outside the current
    // branch). Take the last entry whose chain is whole then, rather than losing
    // the history above it.
    const preferred = overlay.leaf !== null && !carriesLeaf ? overlay.leaf : (base?.leafId ?? null);
    let leaf = preferred !== null && reachesRoot(entries, preferred) ? preferred : null;
    if (leaf === null) {
        for (let index = order.length - 1; index >= 0; index -= 1) {
            const id = order[index];
            if (reachesRoot(entries, id)) {
                leaf = id;
                break;
            }
        }
    }
    return { entries, order, leaf };
}

/** Whether the parent chain of one entry reaches a root without a missing link. */
function reachesRoot(entries: Map<string, SessionEntry>, leaf: string): boolean {
    const seen = new Set<string>();
    let current: string | null = leaf;
    while (current !== null) {
        if (seen.has(current)) return false;
        seen.add(current);
        const entry = entries.get(current);
        if (entry === undefined) return false;
        current = entry.parentId;
    }
    return true;
}

/**
 * Takes a base read as the authority for the entries it carries: its entries replace
 * the overlay's, the rest of the overlay stays, dead row names are pruned, and every
 * live message whose entry the transcript now holds is superseded.
 */
export function acceptSnapshot(state: StreamState, answer: EntriesData): StreamState {
    const carried = new Set(answer.entries.map((entry) => entry.id));
    const order = state.overlay.order.filter((id) => !carried.has(id));
    const entries = new Map<string, SessionEntry>();
    for (const id of order) {
        const entry = state.overlay.entries.get(id);
        if (entry) entries.set(id, entry);
    }
    const paired = supersede(answer.entries, state);

    // A row name for an entry that the answer dropped and the overlay lost is dead.
    const alive = new Set([...carried, ...order]);
    const rowIds = new Map([...paired.rowIds].filter(([entryId]) => alive.has(entryId)));

    return {
        overlay: { entries, order, leaf: order[order.length - 1] ?? null },
        live: paired.live,
        queued: state.queued,
        rowIds,
        nextLive: state.nextLive,
        bash: state.bash === null ? null : bashAfter(state.bash, answer.entries),
        usage: settledUsage(state.usage, paired.superseded),
    };
}

/** Takes one entry the wire carried, and supersedes the live row it is. */
export function acceptEntry(state: StreamState, entry: SessionEntry): StreamState {
    const paired = supersede([entry], state);
    const overlay = state.overlay.entries.has(entry.id)
        ? state.overlay
        : {
              entries: new Map(state.overlay.entries).set(entry.id, entry),
              order: [...state.overlay.order, entry.id],
              leaf: entry.id,
          };
    return {
        overlay,
        live: paired.live,
        queued: state.queued,
        rowIds: paired.rowIds,
        nextLive: state.nextLive,
        bash: state.bash === null ? null : bashAfter(state.bash, [entry]),
        usage: settledUsage(state.usage, paired.superseded),
    };
}

/** The shell card that an entry of the transcript recorded, or the same card while no entry is its. */
export function bashAfter(bash: BashRun, entries: Iterable<SessionEntry>): BashRun | null {
    for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "bashExecution") continue;
        if (entry.message.command === bash.command) return null;
    }
    return bash;
}

/** The usage of a response whose entry arrived is the entry's now: the increment goes. */
function settledUsage(usage: LiveUsage | null, superseded: string[]): LiveUsage | null {
    return usage !== null && usage.liveId !== "" && superseded.includes(usage.liveId) ? null : usage;
}

/**
 * Pairs entries with live messages in order, so that two messages of one identity
 * cannot cross: the first unmatched live row takes the first entry. The row keeps its
 * name, and the live row goes.
 */
function supersede(
    entries: Iterable<SessionEntry>,
    state: StreamState,
): Pick<StreamState, "live" | "rowIds"> & { superseded: string[] } {
    const claimed = new Set<number>();
    const rowIds = new Map(state.rowIds);
    const superseded: string[] = [];
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const key = identity(entry.message);
        const at = state.live.messages.findIndex(
            (live, index) => !claimed.has(index) && identity(live.message) === key,
        );
        if (at < 0) continue;
        claimed.add(at);
        rowIds.set(entry.id, state.live.messages[at].id);
        superseded.push(state.live.messages[at].id);
    }
    return { live: { messages: state.live.messages.filter((_, index) => !claimed.has(index)) }, rowIds, superseded };
}

// The writes of a run, each on the state the machine holds.

/** A message of the run began. */
export function liveStart(state: StreamState, message: AgentMessage): StreamState {
    return {
        ...state,
        live: beginMessage(state.live, `live-${state.nextLive}`, message),
        nextLive: state.nextLive + 1,
    };
}

/** A delta of the message that streams, and the cumulative usage it reports. */
export function liveDelta(state: StreamState, event: AssistantMessageEvent, usage: Usage, at: number): StreamState {
    const liveId = lastAssistant(state.live)?.id ?? state.usage?.liveId ?? "";
    return { ...state, live: applyDelta(state.live, event), usage: { usage, liveId, at } };
}

/** A message of the run finished; the final message is the authority. */
export function liveEnd(state: StreamState, message: AgentMessage): StreamState {
    return { ...state, live: endMessage(state.live, message) };
}

/** A tool call started, with the arguments the tool was called with. */
export function liveToolStart(state: StreamState, call: { toolCallId: string; args: JsonValue }): StreamState {
    return { ...state, live: startCall(state.live, call) };
}

/** What a tool call streamed, which is its whole output so far. */
export function liveToolUpdate(
    state: StreamState,
    call: { toolCallId: string; toolName: string; partialResult: JsonValue },
): StreamState {
    return { ...state, live: updateCall(state.live, call) };
}

/** What a tool call answered. */
export function liveToolEnd(
    state: StreamState,
    call: { toolCallId: string; toolName: string; result: JsonValue; isError: boolean },
): StreamState {
    return { ...state, live: endCall(state.live, call) };
}

/** Pi takes the turn up again: its failure is not the end of the run. */
export function liveRetrying(state: StreamState): StreamState {
    return { ...state, live: markRetrying(state.live) };
}

/** The last live message the model wrote, which is where a delta lands. */
function lastAssistant(run: LiveRun): { id: string } | undefined {
    for (let index = run.messages.length - 1; index >= 0; index -= 1) {
        if (run.messages[index].message.role === "assistant") return run.messages[index];
    }
    return undefined;
}
