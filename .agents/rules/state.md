# State rules — apply to src/**

Every piece of state has one home, and the home follows what the state IS. Ask
in this order: a read's answer is not content, and a phase is not bytes.

## Which home

| Kind                                                    | Home                                      | Examples                                                                      |
| ------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| A question to Rust: cacheable, with a named failure     | TanStack Query (`lib/query.ts`)           | the session's state, entries, stats, models; the session list; the connection |
| Content that grows, appended from a non-React seam      | zustand store (`src/stores/`)             | transcript entries; the run's messages while they stream; a command's output  |
| A sequence with rules, or a latch over reads and events | XState statechart (`src/machines/`)       | the connection lifecycle; a run's phase; a host-key question; a prompt queue  |
| One fact for the whole app, needed before React mounts  | module singleton + `useSyncExternalStore` | the platform (`hooks/use-platform.ts`); the shared hourglass clock            |
| What one component shows, and nothing else              | `useState`/`useRef` in that component     | an expansion, a fold, the draft, a measurement                                |

Three things are not state at all:

- **Derived**: a value that is a function of the above is a function, not state
  — `lib/transcript.ts`, `lib/stream.ts`,
  `routes/chat/components/session/session.ts`.
- **CSS's**: a width, a hover, a transition. Reach for a variant or a media
  query first; `hooks/use-wide-window.ts` names the two cases where JavaScript
  must ask (a column hidden by `display: none` still reads, an open sheet holds
  the page).
- **Rust's**: the connection, the session in view, the session file. Read them
  back; never keep a second copy of an answer Rust owns.

## The seam

One stream has one seam: the single place that subscribes to its records. Today
`hooks/use-session.ts` is the seam of a session. The seam holds the three reads
of the session, and hands the records to what owns them: the chart, which knows
whether a record may draw and where the phase goes
(`machines/session.machine.ts`), the table that says where each record belongs
(`lib/session-records.ts`), and the actor that buffers them (`fromCallback` in
the chart).

- Components never subscribe to Tauri events. The mechanism lives in
  `src/lib/bridge/`, and the seam is its only caller for a given stream.
- A record reaches the chart as an event payload. Payloads are transient and
  MUST NEVER enter chart context.
- Where a record goes is a table over injected dependencies
  (`lib/session-records.ts`), so a test feeds it records and the code that holds
  the subscription has no switch of its own.
- Buffering (one write per frame) lives in the actor that holds the
  subscription - not in a component, and not in the store: the batch goes in one
  write, a record that is not a delta flushes the batch first, and a buffer
  whose subscription dies is cancelled with it.
- One writer per value. A chart migrates its own states, a store owns its
  slices, and a query is invalidated, never written: the only `setQueryData`
  calls are in `__stories__`, which seed a cache so a story renders with no
  host. The sender of a command is a legitimate second writer: it opens the row
  of the run it started (`Composer`'s shell card) and the record that ends the
  run closes it.
- An identity change (another session, another connection) clears what belonged
  to the old one: reset the store, remount the chart (a `key` gives that), drop
  the records of the stream being left, dismiss its toasts.

## Charts (XState)

- A multi-step flow with temporal invariants is modeled as a chart BEFORE its
  components are written.
- Machines are fully declared: states, events, guards, transitions. Components
  read one through `@xstate/react` (`useMachine`, `useSelector`); the seam or
  the screen that owns the flow creates the actor.
- No hidden boolean or ref beside a chart that already encodes it. Sharper: a
  flag that decides whether a record may be applied, or whether a read still
  counts, is a state of that chart — not an implementation detail.
- A phase belongs to the chart (`idle`/`waiting`/`working`,
  `machines/session.machine.ts`); the bytes belong to the store. A read never
  moves a phase: it answers about the past, so it is latched (see Latches and
  order).
- Request lifecycles (subscribe, handshake, ask) are actors, and the race where
  the answer arrives after the state was left is handled inside the actor
  (`connection.machine.ts`).
- Side effects arrive as injectable deps, so the graph is testable with no Tauri
  runtime (`ConnectionDeps` is the model).
- A value that outlives the chart does not go into context: Rust is the source
  of truth and a read is how it comes back (`session.machine.ts`).
- Streaming content MUST NEVER enter chart context — routing message deltas
  through a machine is an anti-pattern by definition.

## Stores (zustand)

- Event-sourced and append-only. `hydrate` is the one exception: it lays a
  snapshot UNDER what the store holds, and a record that arrived during the read
  stands.
- Granular selectors, one per value; React reads a slice, never the store.
- No phases, no derived state, no I/O.
- One entity at a time: one session, one connection. A second one at once needs
  a store per entity or a `key` that remounts.
- Nothing of another identity stays: a store keeps what the identity it was
  given owns, and the seam clears it when that changes.

## Queries (TanStack Query)

- Keys mirror the RPC command (`["session", id, "entries"]`), so the place that
  invalidates a cache names the same thing as the place that reads it.
- Events invalidate caches; they never mutate them ad hoc. A call site that sent
  a command may invalidate what that command made stale (`Composer` after a
  shell command, `ModePickers` after a pick), and an area key invalidates the
  whole area when the answer is "everything of this session"
  (`["session", id]`).
- Time is not a signal: `staleTime: Infinity` and no refetch on focus
  (`lib/query.ts`), because an answer changes when an event says so. The one
  read whose answer changes with no event is `connectionQueries.current`
  (`staleTime: 0`), and it says why.
- `retry: false` unless a retry could change the answer; a fallback interval
  belongs to the call site that needs it, with its reason written down
  (`statsRefetchInterval`).
- A snapshot of a read is the authority for the past; the rows built from
  records stand until it arrives.

## Component state

- Lifetime equals component lifetime. A value that must survive a remount is not
  component state.
- Refs are for DOM handles, clocks, latches, and accumulators that must not
  re-render; read one into state when a render needs it
  (`TranscriptList.atEnd`).
- Domain state is not component state: "a switch is in flight", "this
  subscription is open". That is a chart.

## App-wide facts

- Only one fact per app qualifies: it must exist before React mounts and outlive
  every component.
- The shape is fixed: module variable(s), a set of readers, a `subscribe` that
  returns an unsubscribe, and a snapshot that never rejects — a failure is
  `null` plus a `console.error`, so the app needs no provider and no error
  boundary (`hooks/use-platform.ts` is the model).
- It is not a second store: needs a time base, a failure reason, or
  invalidation, then it is a query; grows over time, then it is a store.
- A **driver** singleton is the same pattern for a value React never reads: one
  animation drives N readers, and each writes what it draws into its own refs so
  a 60 Hz clock costs no renders (`components/Hourglass.tsx` is the model). It
  needs no snapshot, and a value that a render reads is not a driver.

## Latches and order

1. **An event outranks a read.** A read's answer was formed before the records
   that arrived after it was asked for; the chart latches the first record of a
   run and drops a read that follows. Opening the listeners again opens the
   latch again, because a closed listener loses its records.
2. **A snapshot owns the past and the settled; records own the now.** The
   snapshot replaces rows. A phase is not the snapshot's to move.
3. **A row's identity outlives its replacement.** When a snapshot takes over a
   message the run drew, the row keeps its name, so a clock, an open body and a
   React key do not start over (`rowIds`).
4. **An identity change drops the old stream's tail.** A record that arrives
   while a switch is on its way may belong to the conversation being left, and
   the read after the switch is what repopulates.
5. **A buffer is flushed before anything that is not a delta**, and cancelled
   when its seam dies.

## Tests

- A chart: path enumeration (`@xstate/graph`, `statechart-pattern.test.ts`) plus
  explicit cases for the paths that carry an invariant; inject deps so no Tauri
  runtime is needed.
- A store and the pure functions beside it: assert on `getState()` and on the
  functions directly.
- The seam: its routing is a table over injected dependencies, so a test feeds
  it records; the event bus belongs to the integration tests.
- A query: build the test client from the exported `queryDefaults`, or a warm
  cache behaves unlike the app's.
- Component state: Testing Library. happy-dom lays nothing out, so assert on
  calls and attributes rather than on pixels (`CommandMenu`'s scroll probe).
