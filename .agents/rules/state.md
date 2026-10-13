# State Management Rules (for LLM agents)

> **Audience:** coding agents working in this repo. **Stack:** XState v5
> (`xstate`, `@xstate/react`), React hooks, TanStack Query v5, Zustand v5. **Do
> not add any other state library.** Do not use `useReducer`, Redux,
> Context-as-store, or `useEffect` for data sync.
>
> **Terminology note:** in this repo "the server" means the Rust backend. Reads
> reach it through Tauri commands, writes are commands, and events drive
> invalidation. "API functions" below means the plain command wrappers.

## 0. How to use this file

Before writing or changing ANY state, you MUST:

1. Run the **Decision Procedure** (section 2) for each piece of state.
2. Follow the **Combination Rules** (section 4) if more than one tool is
   involved.
3. Run the **Self-Check** (section 7) before declaring the task done.
4. Include a **State Decision Note** (section 8) in your response or PR
   description.

If this file conflicts with existing code, follow this file for new code and do
NOT rewrite unrelated old code unless asked.

---

## 1. Responsibilities (one owner per kind of state)

| Tool                                              | One-line role                   | OWNS                                                                                                                                              | NEVER owns                                                                                                   |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **TanStack Query**                                | What the **server knows**       | Remote data that can be refetched, cached, invalidated: lists, details, pagination, infinite scroll, mutations' network status                    | Client-only values; multi-step flow logic; copies of its data in other stores                                |
| **XState**                                        | What the app is **doing**       | Behavior: modes, transitions, guards, async orchestration (retry, cancel, timeout), multi-step flows, lifecycle of connections/sessions/uploads   | Cached server entities; plain values with no transitions                                                     |
| **Zustand**                                       | What the app **remembers**      | Plain values shared by distant components or that outlive a component: theme, sidebar open, user preferences, feature flags, command palette open | Server data; loading/error/status flags of flows; multi-step logic; fetching                                 |
| **React hooks** (`useState`, `useRef`, `useMemo`) | What a component is **showing** | Ephemeral leaf-level view state, refs, derived values                                                                                             | Anything needed outside the component and its direct children; anything with related booleans or transitions |
| **URL** (router / search params)                  | What the user can **link to**   | Filters, sort, page, selected tab/id: anything that must survive refresh, be shareable, or work with the Back button                              | Transient UI state                                                                                           |

Mnemonic: **Query = server knows. XState = app is doing. Zustand = app
remembers. Hooks = component shows. URL = user can link.**

---

## 2. Decision Procedure (ask in order; the FIRST "yes" decides)

For each piece of state, answer these questions top to bottom. Stop at the first
"yes".

**Q1. Can it be derived from existing state, props, or query data?** → **Do not
store it.** Compute inline, with `useMemo`, a Zustand selector, or a Query
`select`.

**Q2. Must it survive refresh, be shareable by link, or work with
Back/Forward?** → **URL state.**

**Q3. Does the server own it, and can it be refetched?** → **TanStack Query.**
(Reads: `useQuery`. Writes: `useMutation`, unless Q4 also applies.)

**Q4. Does it have behavior?** Answer yes if ANY of these is true:

- It has two or more **mutually exclusive modes** (e.g.
  `idle | submitting | failed | done`).
- Changes are triggered by **events with guards or conditions** ("only if step 2
  is valid").
- It involves **async work needing cancel, retry, timeout, or sequencing**.
- You are about to write **two or more related booleans** (`isOpen` +
  `isLoading` + `hasError`) or a `status` string.
- **Impossible states** could occur (`isLoading && isError`). → **XState.**

**Q5. Do multiple distant components need it, or must it outlive the component
that created it?** → **Zustand.**

**Q6. Otherwise** → **`useState` / `useRef`** in the component that uses it.

### Tie-breakers

- Priority when several seem to fit: **derived > URL > Query > XState >
  Zustand > hooks.**
- The state-diagram test for XState: sketch the diagram. If there are **fewer
  than 2 states with meaningful transitions**, or the only event would be
  `SET_VALUE`, it is NOT a machine. Use Zustand or `useState`.
- A local `useState` that grows a second related boolean MUST be promoted to
  XState (see section 6).
- If still unsure, pick by the priority order, then state the assumption in your
  State Decision Note. Do not stop to ask unless the choice changes the
  architecture.

---

## 3. Quick lookup

| If the thing is...                                            | Use                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A list/detail fetched from an API                             | Query                                                                                    |
| Create/update/delete request                                  | Query `useMutation` (single request) or XState (multi-step, retry, or confirmation flow) |
| Wizard / multi-step form flow / checkout                      | XState                                                                                   |
| File upload with progress, cancel, retry                      | XState                                                                                   |
| Auth/session lifecycle (login, refresh, logout)               | XState (app-global singleton)                                                            |
| WebSocket / SSE connection lifecycle                          | XState                                                                                   |
| Drag-and-drop, long-press, gesture sequences                  | XState                                                                                   |
| Modal with a confirm/loading/error flow                       | XState                                                                                   |
| Theme, locale, sidebar collapsed, density                     | Zustand (`persist` middleware if needed)                                                 |
| Feature flags, user preferences                               | Zustand (or Query if the server is the source of truth)                                  |
| Search text, filters, sort, page, selected tab                | URL                                                                                      |
| Tooltip/dropdown open, hover, focus, uncontrolled input draft | `useState`                                                                               |
| DOM node, timer id, previous value                            | `useRef`                                                                                 |
| Something computed from other state                           | Derive. Do not store.                                                                    |

---

## 4. Combination Rules

### 4.1 Data-flow direction (the only allowed edges)

```
Components ──read/send──▶ Query hooks | Zustand selectors | XState actors | useState
XState actors ──may──▶ queryClient (invalidate / setQueryData / fetchQuery)
XState actors ──may──▶ Zustand actions (write only, via getState())
Zustand stores ──▶ nothing (no imports of Query or XState)
Query queryFn ──▶ plain API functions only (no imports of Zustand or XState)
```

| From → To                     | Allowed?    | How                                                                                                                                               |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| XState → Query                | Yes         | Pass `queryClient` as machine `input`. Use `invalidateQueries` / `setQueryData` on completion. Never call hooks inside machines.                  |
| XState → Zustand              | Yes (write) | Action calls `useXStore.getState().setX(...)`. Prefer passing read values in via `input` or event payload instead of reading the store in guards. |
| Zustand → XState              | No          | Never. Components send events to machines.                                                                                                        |
| Zustand → Query               | No          | Stores don't fetch or hold query data.                                                                                                            |
| Query → Zustand / XState      | No          | `queryFn` is a pure API call. Use `onSuccess`-style side effects in a machine or component, not the store.                                        |
| Component → any               | Yes         | Components wire tools together.                                                                                                                   |
| Zustand ↔ XState two-way sync | No          | One source of truth per fact.                                                                                                                     |

### 4.2 Recipes

**Recipe A: Workflow + server data (XState + Query).** The machine owns the
_flow_, Query owns the _data_. The machine holds drafts and IDs, never fetched
entities. On success it invalidates queries.

```ts
// features/orders/queries.ts: key factory, shared by hooks and machines
export const orderKeys = {
  all: ["orders"] as const,
  detail: (id: string) => [...orderKeys.all, id] as const,
};

// features/orders/checkout.machine.ts
export const checkoutMachine = setup({
  types: {
    context: {} as { draft: Draft; queryClient: QueryClient },
    input: {} as { queryClient: QueryClient },
  },
  actors: {
    submitOrder: fromPromise(({ input }: { input: Draft }) =>
      api.createOrder(input),
    ),
  },
  actions: {
    refreshOrders: ({ context }) =>
      context.queryClient.invalidateQueries({ queryKey: orderKeys.all }),
  },
}).createMachine({
  context: ({ input }) => ({
    draft: emptyDraft,
    queryClient: input.queryClient,
  }),
  initial: "editing",
  states: {
    editing: { on: { SUBMIT: "submitting" } },
    submitting: {
      invoke: {
        src: "submitOrder",
        input: ({ context }) => context.draft,
        onDone: { target: "done", actions: "refreshOrders" }, // invalidate, don't copy
        onError: "failed",
      },
    },
    failed: { on: { RETRY: "submitting", EDIT: "editing" } },
    done: { type: "final" },
  },
});

// component
const queryClient = useQueryClient();
const [snapshot, send] = useMachine(checkoutMachine, {
  input: { queryClient },
});
const { data: orders } = useQuery(ordersQueryOptions()); // reads still go through Query
```

**Recipe B: Preferences + server data (Zustand + Query).** Zustand holds the
preference value. The component reads it with a selector and passes it into the
query key or `select`. Do NOT store the query result in Zustand.

```ts
const density = useUiStore((s) => s.density); // value from Zustand
const { data } = useQuery({
  ...ordersQueryOptions(),
  select: (d) => format(d, density),
});
```

If the value should be shareable or survive refresh (filters, sort, page), it is
URL state, not Zustand.

**Recipe C: Workflow result → app-wide value (XState → Zustand).** When a flow
finishes and the outcome must be visible elsewhere, a machine action writes a
plain value to the store. The store never calls back.

```ts
actions: {
  publishSession: ({ event }) => useSessionStore.getState().setUser(event.output.user),
}
```

**Recipe D: Local view state next to everything else (hooks).** Hover, tooltip,
and focus stay in `useState` even inside a component that also uses machines or
queries. Do not move them into a machine or store.

**Recipe E: Forms.**

- Field values and validation → the repo's form library if one exists; otherwise
  `useState` for a single field.
- Submit lifecycle (submitting / failed / retry / success) → XState if
  multi-step or retriable; `useMutation` if it is a single request.
- Never mirror form values into Zustand.

### 4.3 Machine placement (XState scope)

| Scope                           | Use                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| One component                   | `useMachine` / `useActor` inside the component                                     |
| One feature, several components | `createActorContext` from `@xstate/react`, provided at the feature root            |
| App-wide                        | Only true singletons (auth session, realtime connection), created once at app root |

Subscribe with `useSelector(actor, selector)` when a component needs only part
of a snapshot.

### 4.4 Zustand discipline

- One store per domain slice (`useUiStore`, `useSessionStore`), not one giant
  store.
- Actions live **inside** the store.
- Components MUST use selectors: `useUiStore((s) => s.sidebarOpen)`. NEVER
  `useUiStore()` without a selector. Use `useShallow` when selecting multiple
  fields.
- No `fetch`, no `async` actions, no `status` fields in stores.

### 4.5 Query discipline

- Define query keys in a **key factory** per feature (`orderKeys`).
- Wrap queries in custom hooks or `queryOptions()` helpers; `queryFn` calls
  plain API functions.
- Derive with `select`; do not copy data into `useState`.
- Mutations that are a single request use `useMutation` and invalidate in
  `onSuccess`.

---

## 5. Hard prohibitions (NEVER)

1. NEVER copy server data into Zustand, XState context, or `useState`.
2. NEVER store `isLoading` / `isError` / `status` in Zustand or hand-rolled
   state for server calls. Use Query status or a machine state.
3. NEVER use `useEffect` to fetch data, to copy props/state into state, or to
   sync two stores. `useEffect` is allowed ONLY to subscribe to external systems
   (DOM events, timers, third-party widgets).
4. NEVER use `useReducer`. If state needs a reducer it has transitions, so use
   XState.
5. NEVER create a machine that has one state and only `SET_VALUE` events.
6. NEVER keep the same fact in two places (Zustand and a machine, Query and a
   store, URL and a store).
7. NEVER subscribe to a whole Zustand store, and NEVER fetch inside a store.
8. NEVER call React hooks inside machine definitions or store definitions.
9. NEVER use React Context as a general-purpose state store. Context is only for
   injecting actors/clients/providers.
10. NEVER introduce a new state library or a second pattern for something an
    existing owner already covers.

### Documented exceptions

Two exceptions to the rules above are approved for the session transcript. Each
exception holds only under its conditions; remove it when the conditions no
longer hold.

**1. The session transcript overlay (exception to prohibition 1).** A session
machine may hold in its context the entries that arrive as records between two
reads (the overlay). Conditions: the values are stream data only; they are never
fetched; a base read prunes them; the base itself stays in Query. Reason: the
event bus has no replay, and a new base answer must merge with the entries that
arrived after the request.

**2. A Query answer sent to a machine (exception to prohibition 3).** A
component effect may observe a Query answer and send it to a machine as an
event. The effect does not fetch; Query fetches. The machine applies the answer
under its own ordering guards. This is the Component -> XState edge, with Query
as the source.

---

## 6. Escalation / demotion triggers

| Situation                                                                                 | Action                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `useState` component now has a second boolean related to the first, or a `status` string  | **Promote to XState**                                                                 |
| `useState` value is needed by a component more than 2 levels away, or in a distant branch | **Promote to Zustand** (or use composition first if it is a simple parent/child case) |
| Zustand store gained `status`, `loading`, `error`, or async actions                       | **Move that part to XState** (flow) or **Query** (server data)                        |
| XState machine collapsed to a single state with `SET_VALUE` only                          | **Demote to Zustand or `useState`**                                                   |
| Local filter/sort/page state needs to be shareable                                        | **Move to URL**                                                                       |
| Data fetched in a machine is read by several components                                   | **Move the read into Query**; the machine only triggers/invalidates                   |

---

## 7. Self-Check (run before finishing; every box must be true)

- [ ] Every new piece of state went through the Decision Procedure; I can name
      its owner.
- [ ] Nothing derivable is stored.
- [ ] No server data lives outside Query (no copies in Zustand, machine context,
      or `useState`).
- [ ] No `isLoading` / `isError` / `status` fields outside Query or a machine.
- [ ] No related booleans; any such group became a machine.
- [ ] No `useEffect` used for fetching or state syncing; no `useReducer`.
- [ ] Each fact lives in exactly one place; no two-way sync.
- [ ] Data flows only along the allowed edges in section 4.1 (stores import
      neither Query nor XState; `queryFn` imports neither Zustand nor XState).
- [ ] Machines receive I/O (`queryClient`, API functions) via `input`/`actors`,
      hold IDs and drafts only, and invalidate Query on completion.
- [ ] Zustand: sliced store, actions inside the store, components use selectors.
- [ ] Query: keys come from a factory; `queryFn` is a plain API call.
- [ ] Machine scope matches section 4.3 (local / feature / app-global).
- [ ] Shareable or refresh-surviving state is in the URL.
- [ ] I added no new dependencies.

---

## 8. Required output: State Decision Note

When you add or change state, include a short note in your reply or PR
description in this format:

```
State decisions:
- <state name>: <Query | XState | Zustand | hooks | URL | derived>. Reason: <Q# that matched, in one line>.
- Combination: <e.g. "XState checkout machine invalidates orderKeys.all on success (Recipe A)">
- Assumptions: <anything you were unsure about, or "none">
```

Example:

```
State decisions:
- orders list: Query. Reason: Q3, server-owned, refetchable.
- checkout flow (editing/submitting/failed/done): XState. Reason: Q4, mutually exclusive modes + retry.
- sidebar collapsed: Zustand. Reason: Q5, read by header and layout.
- tooltip open: useState. Reason: Q6, leaf-level view state.
- Combination: checkout machine invalidates orderKeys.all on success (Recipe A).
- Assumptions: none.
```

---

## 9. Layout principles (no prescribed directory tree)

Responsibilities, not paths. Wherever the files live:

- Plain API functions stay apart from React and state libraries; nothing imports
  hooks, stores, or machines from them.
- Query keys, options, and hooks group per feature around one key factory.
- Machines stay pure: I/O arrives via `input` and actors, never via imports.
- Stores stay sliced per domain, with actions inside and selectors outside.
- Screens own their machines and their local `useState`; shared actors get an
  explicit scope, never an implicit global. The session actors live in one
  module registry (`src/lib/sessions.ts`): it holds one actor per attached
  session, counts the screens that hold it, and a screen selects an actor rather
  than creating one.
