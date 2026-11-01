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
src-tauri/src/host/      A machine: the reach to it, the connection pie holds, its
                         files
src-tauri/src/session/   The conversations: the scan of their files, and one
                         pi process each
src-tauri/src/state.rs   What every command shares: the hosts, the bus, and
                         the caches
src-tauri/src/commands/  The IPC surface: one file per area (app, filesystem,
                         host, log, session)
src-tauri/src/bus.rs     The event channel and the ask channel to the frontend
src-tauri/src/error.rs   The failure a command returns
src-tauri/src/log.rs     Where pie's own log goes
pi_rpc (git dependency)  The protocol crate: Pi's wire types, framing, client
```

The dependency direction is `commands -> state -> host -> channel -> pi_rpc`.
`bus` sits beside every layer, because a session asks the frontend a question
while pi waits for the answer; `error` is the command layer's alone.
`state::LocalDirs` is the one value that travels the other way: a plain record
of pie's own directories, handed to `host::connect` and read nowhere else in
`host`.

`session` is a peer of `host`, not a layer above it: `HostConnection` holds the
target, the reach and the running `Session`s, while `session::store` reads a
machine through `host::fs`. They name each other on purpose, and the interface
between them stays small: `Executor`, `FileSystem`, `Session`, `SessionInfo`.

`host::Host` is the enum over the two transports. `enum_dispatch` gives it
`Executor` and `FileSystem`, so neither a trait object nor a hand-written
delegation exists in this crate. `HostConnection` is a plain struct beside it:
the enum carries no fields, so the state a connection owns sits there.

## Hard boundaries

- React MUST NOT: spawn processes, open sockets, know about SSH, speak the Pi
  wire protocol, or make policy decisions. It renders state and invokes Tauri
  commands.
- React MUST NOT import a `@tauri-apps/plugin-*` npm package. A plugin reaches
  the machine through permissions the capability file grants, and the frontend
  reaching one directly puts a second, unpoliced way out beside the command
  boundary. The Rust side registers the plugin it wants and exports a command
  (`filesystem_create_dir_all`, `filesystem_read`, `filesystem_read_metadata`,
  `filesystem_select_files` in `commands/filesystem.rs`, over
  `tauri-plugin-dialog` + `tauri-plugin-fs`, or `commands::app::app_open_url`
  over `tauri-plugin-opener`); drop the npm package with it;
  `src-tauri/capabilities/default.json` grants no plugin permission, because the
  frontend reaches no plugin directly. `@tauri-apps/api` is not a plugin:
  `invoke`, the event bus and the window live in `src/lib/bridge/` and are the
  bridge itself.
- Rust (`src-tauri`) owns ALL logic: process supervision, the reach to a
  machine, retries and backoff, host-key verification, protocol normalization,
  error mapping.
- The reach and the pi processes have one owner. `state::AppState` keeps one
  `Arc<HostConnection>` per connection name, and `HostConnection` keeps the
  target, the reach and the running `Session`s. A command reaches no socket and
  no `pi` process except through `HostConnection`. The conversation files are
  the only catalog: `list_sessions` scans them, so a conversation another pi
  wrote shows up without a refresh step.
- The `pi_rpc` crate MUST stay protocol-only: it knows JSONL, types, framing and
  a client, and it owns no socket, process or TLS — a caller hands it a
  `Transport`. It has no `tauri` dependency and no connection policy. The
  boundary is the crate edge, so the compiler holds it; do not add app concerns
  to it, and put them in `src-tauri/src/channel/` or `src-tauri/src/host/`.
- A local program and an SSH one MUST share one protocol layer — only the
  channel differs (`tokio::process::Child` pipes vs a `russh` exec channel), and
  both are `channel::Channel` values in `src-tauri/src/channel/`. No PTY
  anywhere: Pi rpc is stdio.
- A session is named by its conversation file: a `typed_path::Utf8TypedPathBuf`
  of the machine that holds it. pi's own `SessionId` travels with a conversation
  (it is `SessionInfo.id`) but never selects one: `pi --session-id` looks only
  inside the project directory of the working directory, and two projects can
  hold the same id.
- A path of the connected machine is `typed_path`: `Utf8TypedPath`, or
  `Utf8TypedPathBuf` when it is owned. The operating system of that machine
  decides the shape of a path, and pie does not know it, so the filesystem layer
  checks the family (`host::fs::{require_absolute, check_type}`) wherever a path
  arrives. A path of pie's own machine is `camino::Utf8PathBuf`, which is always
  UTF-8.

## IPC contract

- Commands live in `src-tauri/src/commands/`, snake_case, and return
  `Result<T, PieError>` — never a bare string error. The two bus calls, `answer`
  and `ready_for_answer`, answer the bus directly and are not fallible.
- A command function is named `<area>_<operation>`: `host_create_dir_all` in
  `commands/host.rs`. The wire name stays short, and the attribute carries it:
  `#[tauri::command(rename = "create_dir_all")]`. Both names must be unique in
  the crate. The function identifier, because the macro exports
  `__cmd__<identifier>` at the crate root; the wire name, because the dispatcher
  matches it as a string. `lib.rs` imports the areas with a glob and lists the
  bare identifiers in dictionary order, and each file keeps its own commands in
  dictionary order.
- Events are named `pi://<area>/<event>`: `pi://ask/{extension,host_key}`,
  `pi://connection/state`, `pi://extension/{notice,status,title,editor}`,
  `pi://session/{event,ended}`, and `pi://upload/{upload_id}`. A payload that
  names a session carries its conversation file in `session` (`Utf8TypedPathBuf`
  in Rust, a string on the wire). An upload event reports `{ bytes, total }`
  while the file travels, and the answer of the call is the receipt; report
  bytes, never a percentage. Field names are camelCase, and a union is tagged on
  a `type` field with snake_case tags (`notice`, `trusted`).
- The wire types (the DTOs that cross the boundary) sit next to the command that
  uses them, usually just above it. An ask payload sits in the module that asks
  it (`session/extension.rs`, `host/ssh/trust.rs`).
- The boundary type is `PieError` (`src-tauri/src/error.rs`): a small enum for
  the failures pie itself decides (`already_connected`, `not_connected`,
  `not_attached`, `bad_argument`, `not_supported`, `unopenable_url`), plus
  `failed` for everything a machine, a program, or the protocol failed on. It
  serializes as one object: `kind` (the name), `message` (the whole chain,
  outermost first, which is what a person reads), and the fields of a named
  variant (`doing`, `session`, `reason`, `what`, `url`, `connection`). A new
  failure from below is a `.context(...)` and needs no change here; a new
  failure of the app is a variant and a name. Never stringify a failure into a
  category of pie's own invention.
- A command asks `commands::host_at` for a connection and `commands::session_at`
  for a running conversation. A name that is not connected is `not_connected`; a
  conversation that does not run is `not_attached`, not `failed`.
- Every layer below the IPC boundary returns `anyhow::Result` and builds the
  sentence where the failure happened: the step (`.context(...)`), the path or
  the endpoint, and the cause. A layer does not name a category of its own, and
  no layer wraps another's failure. The protocol crate keeps its five kinds
  (`pi_rpc::error::ErrorKind`).
- Shared state uses `std::sync` locks. Take what you need from the guard, drop
  it, then `.await`: a `std` guard held across an await makes the command future
  `!Send`, and Tauri spawns it where `Send` is required.
- Attaching a conversation runs `pi --mode rpc --session <path>`, with an
  absolute path of the host. Never `--session-id`: pi resolves that id inside
  the project directory of the working directory, and when it finds the id in
  another project it asks on stdin and prints the question into the JSONL
  stream. With a path, pi takes the working directory from the file's header,
  creates a conversation file that does not exist at that path, and exits 1 when
  the stored working directory is gone.
- Version pinning: `package.json` == `src-tauri/tauri.conf.json` == the version
  of this crate == the Pi release the protocol mirrors. The `pi_rpc` crate names
  the Pi commit the protocol was recorded from in its
  `[package.metadata.pi_rpc] pi_rev`, and `Cargo.lock` holds the revision the
  app resolved.
- The frontend mirrors this surface in `src/lib/bridge/`, one file per area. The
  frontend in the tree predates this rewrite: change it to match Rust, not the
  other way around.
