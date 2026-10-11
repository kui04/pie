# pi_rpc rules — apply to src-tauri/src/transport/** and to the `pi_rpc` crate

`pi_rpc` implements Pi's `--mode rpc` JSONL protocol, mirrored from the pinned
Pi checkout. Fidelity over elegance: that crate is Pi's protocol wearing Rust
types, nothing more. It is a dependency of this app
(`pi_rpc = { git = "https://github.com/kui04/pi_rpc" }`), not a module of it, so
a rule about the protocol is a rule for that repository, and a rule about the
bytes is a rule for `src-tauri/src/transport/`.

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
  response is the crate's own command failure, never a panic. The app reports it
  as `PieError::Rpc` with the crate's coarse kind (`RpcFailure`) and keeps the
  detail on its own side of the boundary, in the log.
- Lifecycle: closing stdin is the graceful shutdown path; handle SIGTERM and
  channel EOF; the SSH case follows the same rules over the russh channel.
- Check `pi --version` against the pin (`transport::probe_version` and
  `transport::check_version`); a mismatch is surfaced as
  `transport::Error::VersionMismatch`, not a silent continue.
- SSH specifics: `russh` with the `ring` crypto backend (Android cross-compile);
  host-key verification is ours to implement (TOFU + known_hosts); private keys
  cross the boundary as text, never as a path to a file — pie copies no secret
  material into its own storage. The frontend turns a file into text, because a
  picked file is a `content://` URI on Android rather than a path at all.
