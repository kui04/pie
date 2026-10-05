# Architecture rules — always apply

Pie is a GUI for [Pi](https://github.com/earendil-works/pi), mobile first. Pi
runs as `pi --mode rpc` (JSONL over stdio) — as a local child process or via SSH
exec. Pie never embeds Pi, never bundles it: the machine running Pi must have
`pi` on PATH, and all model/provider credentials stay on that machine. Pie is
only the presentation.

## Layers

```
src/                    React: UI + UI state only
src-tauri/              Rust app: connection lifecycle, supervision, IPC bridge
src-tauri/src/pi_rpc/   Protocol module: Pi's wire types, framing, transports
```

## Hard boundaries

- React MUST NOT: spawn processes, open sockets, know about SSH, speak the Pi
  wire protocol, or make policy decisions. It renders state and invokes Tauri
  commands.
- React MUST NOT import a `@tauri-apps/plugin-*` npm package. A plugin reaches
  the machine through permissions the capability file grants, and the frontend
  reaching one directly puts a second, unpoliced way out beside the command
  boundary. The Rust side registers the plugin it wants and exports a command
  (`commands::keys::pick_private_key` over `tauri-plugin-dialog` +
  `tauri-plugin-fs`); drop the npm package and the capability permission with
  it. `@tauri-apps/api` is not a plugin: `invoke`, the event bus and the window
  live in `src/lib/bridge/` and are the bridge itself.
- Rust (`src-tauri`) owns ALL logic: process supervision, connection lifecycle,
  retries and backoff, host-key verification, protocol normalization, error
  mapping.
- `pi_rpc` MUST stay protocol-only: it knows JSONL, types, and transports — no
  `tauri` imports, no UI concepts, no connection policy, and no reaching into
  other app modules. It was a separate crate until that was traded for the
  simpler single-crate layout, so this boundary is now a convention:
  `src-tauri/tests/purity.rs` fails the build if it is crossed. Do not weaken
  that test to make room for app concerns — put them outside the module.
- Local and SSH connections MUST share one protocol layer — only the transport
  differs (`tokio::process::Child` stdin/stdout vs a `russh` exec channel). No
  PTY anywhere: Pi rpc is stdio.

## IPC contract

- Commands live in `src-tauri/src/commands/`, snake_case, and return
  `Result<T, PieError>` — never a bare string error.
- Events are namespaced `pi://<area>/{id}`, e.g. `pi://session/{id}/event`,
  `pi://connection/{id}/state`; payloads are tagged on a `type` field. Tag
  values are snake_case (`host_key`); field names are camelCase, matching the
  fields the frontend already reads off Pi's own records.
- Every layer names its own failures as a `thiserror` enum whose variants are
  what a caller matches on: `pi_rpc::Error` for the protocol and its transport,
  `connection::Error` for pie's own reach for a machine (which state the
  connection is in included), `commands::Error` for the IPC layer. No layer
  wraps another's error — a `pi` that is not installed is `pi_rpc::Error`, not a
  variant invented by the layer above it.
- The boundary type is an aggregation, not a taxonomy:
  `PieError::{Connection, Commands, Rpc, Io}` (`src-tauri/src/error.rs`), one
  variant per module, each holding that module's error whole. It serializes as
  `type` (the module), `message` (what a person reads), and `error` — the named
  variant underneath, tagged on `kind`. The frontend branches on `kind`, so it
  reads the name the owning layer gave the failure; a variant added in Rust
  needs no change here. Never stringify a failure into a category of pie's own
  invention.
- Version pinning: `package.json` == `src-tauri/tauri.conf.json` == the `pi_rpc`
  module == the Pi release the protocol mirrors.
