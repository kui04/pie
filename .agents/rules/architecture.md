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
- Events are namespaced `pi://<area>/<id>`, e.g. `pi://session/{id}/event`,
  `pi://connection/{id}/state`; payloads are tagged (`type` field), snake_case.
- The error taxonomy crossing the boundary is fixed:
  `TransportError | AuthError | HostKeyError | ProcessError | RpcError`. Extend
  the enum, never stringify an error.
- Version pinning: `package.json` == `src-tauri/tauri.conf.json` == the `pi_rpc`
  module == the Pi release the protocol mirrors.
