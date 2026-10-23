# Architecture rules — always apply

Pie is a GUI for [Pi](https://github.com/earendil-works/pi), mobile first. Pi
runs as `pi --mode rpc` (JSONL over stdio) — as a local child process or via SSH
exec. Pie never embeds Pi, never bundles it: the machine running Pi must have
`pi` on PATH, and all model/provider credentials stay on that machine. Pie is
only the presentation.

## Layers

```
src/                     React: UI + UI state only, and the IPC surface it calls
src-tauri/src/channel/   One started program: its bytes, and its life
src-tauri/src/host/      A machine: the reach to it, what runs on it, its files
src-tauri/src/session/   The sessions of that machine, and their conversations
src-tauri/src/commands/  The IPC surface: one file per command area (app, files,
                         host, log, session), mirrored 1:1 by src/lib/bridge/,
                         plus pipe.rs to forward session events
pi_rpc (git dependency)  The protocol crate: Pi's wire types, framing, client
```

The dependency direction is `commands -> session -> host -> channel -> pi_rpc`,
and `tests/layering.rs` is what holds it.

## Hard boundaries

- React MUST NOT: spawn processes, open sockets, know about SSH, speak the Pi
  wire protocol, or make policy decisions. It renders state and invokes Tauri
  commands.
- React MUST NOT import a `@tauri-apps/plugin-*` npm package. A plugin reaches
  the machine through permissions the capability file grants, and the frontend
  reaching one directly puts a second, unpoliced way out beside the command
  boundary. The Rust side registers the plugin it wants and exports a command
  (`commands::files::{pick_paths, read_text_file}` over `tauri-plugin-dialog` +
  `tauri-plugin-fs`, or `commands::app::open_url` over `tauri-plugin-opener`);
  drop the npm package with it; `src-tauri/capabilities/default.json` grants no
  plugin permission, because the frontend reaches no plugin directly.
  `@tauri-apps/api` is not a plugin: `invoke`, the event bus and the window live
  in `src/lib/bridge/` and are the bridge itself.
- Rust (`src-tauri`) owns ALL logic: process supervision, the reach to a
  machine, retries and backoff, host-key verification, protocol normalization,
  error mapping.
- The `pi_rpc` crate MUST stay protocol-only: it knows JSONL, types, framing and
  a client, and it owns no socket, process or TLS — a caller hands it a
  `Transport`. It has no `tauri` dependency and no connection policy. The
  boundary is the crate edge, so the compiler holds it; do not add app concerns
  to it, and put them in `src-tauri/src/channel/` or `src-tauri/src/host/`.
- A local program and an SSH one MUST share one protocol layer — only the
  channel differs (`tokio::process::Child` pipes vs a `russh` exec channel), and
  both are `channel::Channel` values in `src-tauri/src/channel/`. No PTY
  anywhere: Pi rpc is stdio.

## IPC contract

- Commands live in `src-tauri/src/commands/`, snake_case, and return
  `Result<T, PieError>` — never a bare string error.
- Events are namespaced `pi://<area>/{id}`, e.g. `pi://session/{id}/event`,
  `pi://connection/{id}/state`, `pi://upload/{id}`; payloads are tagged on a
  `type` field. Tag values are snake_case (`host_key`); field names are
  camelCase, matching the fields the frontend already reads off Pi's own
  records.
- Every layer below the IPC boundary returns `anyhow::Result` and builds the
  sentence where the failure happened: the step (`.context(...)`), the path or
  the endpoint, and the cause. A layer does not name a category of its own, and
  no layer wraps another's failure. The one typed failure that survives is
  `host::VersionMismatch`: a mismatch is a warning, not a failure of the
  connect, so `Host::connect` matches it and goes on. The protocol crate keeps
  its five kinds (`pi_rpc::error::ErrorKind`).
- The boundary type is `PieError` (`src-tauri/src/error.rs`): a small enum for
  the failures pie itself decides (the state of its one connection, an argument
  it cannot use, an operation the platform does not support, a link it will not
  open), plus `Failed(anyhow::Error)` for everything a machine, a program, or
  the protocol failed on. It serializes as one object: `kind` (the name,
  `failed` when the failure has none of its own), `message` (the whole chain,
  outermost first, which is what a person reads), and the fields of a named
  variant (`doing`, `reason`, `url`). A new failure from below is a
  `.context(...)` and needs no change here; a new failure of the app is a
  variant and a name. Never stringify a failure into a category of pie's own
  invention.
- Version pinning: `package.json` == `src-tauri/tauri.conf.json` == the version
  of this crate == the Pi release the protocol mirrors. The `pi_rpc` crate names
  the Pi commit the protocol was recorded from in its
  `[package.metadata.pi_rpc] pi_rev`; for `1.1.0` that commit is on main after
  the `v1.1.0` tag, while the checkout and the test image stay at the tag.
  `src-tauri/tests/ssh.rs` fails when the test host's image pins another
  release, and `src-tauri/tests/conformance.rs` fails when the corpus records
  one the crate cannot read.
