# State rules — apply to src/**

State is split by kind. Pick the layer by what the state IS, not by convenience.

| Kind                                       | Home                              | Examples                                                      |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------------------- |
| Flows and protocols with impossible states | XState statechart                 | connection lifecycle, extension dialogs, steering/queue modes |
| Streaming content, append-only             | zustand store fed by Tauri events | transcript entries, tool output                               |
| Command-style reads                        | TanStack Query, event-invalidated | get_state, get_entries, models, tree                          |

## XState

- Machines are fully declared: states, events, guards, transitions. No hidden
  boolean flags next to a machine that already encodes them — derive from actor
  state (`if (connected && !authFailed)` beside a connection machine is a bug).
- Machines live in `src/machines/*.machine.ts`; components interact via
  `@xstate/react` actors only.
- Any new multi-step UI flow with temporal invariants MUST be modeled as a
  statechart before writing components.
- Streaming content MUST NEVER enter statechart context — routing message deltas
  through a machine is an anti-pattern by definition.

## Stores and queries

- Zustand stores are event-sourced and append-only; keep selectors granular; no
  derived-state sprawl inside components.
- TanStack Query keys mirror the RPC command, e.g. `["session", id, "entries"]`;
  events invalidate caches, they never mutate them ad hoc.
- React components never subscribe to Tauri events directly — subscriptions live
  in the bridge layer (`src/lib/bridge/`).
