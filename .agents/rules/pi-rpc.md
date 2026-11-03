# pi_rpc rules — apply to src-tauri/src/channel/**, src-tauri/src/host/** and the `pi_rpc` crate

`pi_rpc` implements Pi's `--mode rpc` JSONL protocol, mirrored from the pinned
Pi checkout. Fidelity over elegance: that crate is Pi's protocol wearing Rust
types, nothing more. It is a dependency of this app
(`pi_rpc = { git = "https://github.com/kui04/pi_rpc" }`), not a module of it, so
a rule about the protocol is a rule for that repository, and a rule about the
bytes is a rule for `src-tauri/src/channel/`, and a rule about how a machine is
reached is a rule for `src-tauri/src/host/`.

## Sources of truth, in order

1. The pinned checkout at `.codegraph/.references/pi`:
   `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `rpc-mode.ts`,
   `jsonl.ts`, `packages/coding-agent/src/modes/json-event.ts`, and the shared
   core event types.
2. Pi's own docs at the same version: `rpc.md`, `rpc-commands.md`,
   `rpc-extension-ui.md`, `json.md`, `message-types.md`.

When they conflict, the pinned source wins. NEVER invent protocol fields, rename
Pi's fields, or "improve" wire shapes.

## Type mirroring

- Rust types mirror the TS types 1:1 — tagged enums on the `type` field,
  `#[serde(rename_all = "snake_case")]`, `Option` for optional fields.
- Unknown events or commands MUST NOT crash the client: keep the raw JSON
  (untagged fallback) so protocol additions degrade gracefully until the next
  pin bump.
- A change to the protocol types belongs in the `pi_rpc` crate, and `Cargo.lock`
  in this repository MUST be updated in the same change.

## Runtime rules

- One read loop per connection; fan out through a channel. NEVER block the read
  loop on UI or command handling — Pi relies on stdout backpressure.
- Correlate `id`s in a map; one in-flight request per id; a `success: false`
  response is the crate's own command failure, never a panic. The app passes it
  up as a context of the failing read: the sentence carries the crate's own kind
  and detail to the log and to the frontend.
- Lifecycle: closing stdin is the graceful shutdown path; handle SIGTERM and
  channel EOF; the SSH case follows the same rules over the russh channel.
- Check `pi --version` against the pin (`HostConnection::pi_version` and
  `host::PI_VERSION`): a mismatch is a warning the connect logs and goes on
  from, and a pi that does not answer fails the connect.
- SSH specifics: `russh` with the `ring` crypto backend (Android cross-compile);
  host-key verification is `host::ssh::trust`: trust on first use over an
  OpenSSH known_hosts file, an unknown key put to the person, a changed key
  refused. Private keys cross the connection boundary as text, never as a path
  to a file — pie copies no secret material into its own storage. When a key
  file is picked (a path on desktop or a `content://` URI on Android),
  `commands::filesystem::filesystem_read` reads its text into the form before
  `connect` is called.
