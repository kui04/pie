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
src-tauri/src/transport/  Where pi runs: local process or SSH channel, framing,
                          version probe, lifecycle
pi_rpc (git dependency)  The protocol crate: Pi's wire types, framing, client
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
- The `pi_rpc` crate MUST stay protocol-only: it knows JSONL, types, framing and
  a client, and it owns no socket, process or TLS — a caller hands it a
  `Transport`. It has no `tauri` dependency and no connection policy. The
  boundary is the crate edge, so the compiler holds it; do not add app concerns
  to it, and put them in `src-tauri/src/transport/` or above.
- Local and SSH connections MUST share one protocol layer — only the transport
  differs (`tokio::process::Child` stdin/stdout vs a `russh` exec channel), and
  both are `Peer` values in `src-tauri/src/transport/`. No PTY anywhere: Pi rpc
  is stdio.

## IPC contract

- Commands live in `src-tauri/src/commands/`, snake_case, and return
  `Result<T, PieError>` — never a bare string error.
- Events are namespaced `pi://<area>/{id}`, e.g. `pi://session/{id}/event`,
  `pi://connection/{id}/state`; payloads are tagged on a `type` field. Tag
  values are snake_case (`host_key`); field names are camelCase, matching the
  fields the frontend already reads off Pi's own records.
- Every layer names its own failures as a `thiserror` enum whose variants are
  what a caller matches on: `transport::Error` for a reach for a machine and the
  run of pi on it, `connection::Error` for pie's own reach for a machine (which
  state the connection is in included), `commands::Error` for the IPC layer. No
  layer wraps another's error — a `pi` that is not installed is
  `transport::Error::Spawn`, not a variant invented by the layer above it. The
  protocol crate names its five kinds (`pi_rpc::error::ErrorKind`).
- The boundary type is an aggregation, not a taxonomy:
  `PieError::{Connection, Commands, Rpc, Transport, Io}`
  (`src-tauri/src/error.rs`), one variant per module, each holding that module's
  error whole. It serializes as `type` (the module), `message` (what a person
  reads), and `error` — the named variant underneath, tagged on `kind`. The
  frontend branches on `kind`, so it reads the name the owning layer gave the
  failure; a variant added in Rust needs no change here. Never stringify a
  failure into a category of pie's own invention.
- Version pinning: `package.json` == `src-tauri/tauri.conf.json` == the version
  of this crate == the Pi release the protocol mirrors, and the `pi_rpc` crate
  carries that release's commit in its `[package.metadata.pi_rpc] pi_rev`.
  `src-tauri/tests/ssh.rs` fails when the test host's image pins another
  release, and `src-tauri/tests/conformance.rs` fails when the corpus records
  one the crate cannot read.
