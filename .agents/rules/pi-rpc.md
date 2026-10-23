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
- A change to the protocol types belongs in the crate, and it MUST update the
  recorded JSONL fixtures of this app (`src-tauri/tests/fixtures`, the
  conformance corpus from a real `pi --mode rpc`) in the same change.
  `src-tauri/tests/conformance.rs` is what reads that corpus through the crate:
  a record the crate cannot name fails there.

## Runtime rules

- One read loop per connection; fan out through a channel. NEVER block the read
  loop on UI or command handling — Pi relies on stdout backpressure.
- Correlate `id`s in a map; one in-flight request per id; a `success: false`
  response is the crate's own command failure, never a panic. The app passes it
  up as a context of the failing read: the sentence carries the crate's own kind
  and detail to the log and to the frontend.
- Lifecycle: closing stdin is the graceful shutdown path; handle SIGTERM and
  channel EOF; the SSH case follows the same rules over the russh channel.
- Check `pi --version` against the pin (`host::check_version` and
  `Host::pi_version`); a mismatch is a `host::VersionMismatch`, which the
  connect logs and goes on from - never a silent continue.
- SSH specifics: `russh` with the `ring` crypto backend (Android cross-compile);
  host-key verification is ours to implement (TOFU + known_hosts); private keys
  cross the connection boundary as text, never as a path to a file — pie copies
  no secret material into its own storage. When a key file is picked (a path on
  desktop or a `content://` URI on Android), `commands::files::read_text` reads
  its text into the form before `connect` is called.
