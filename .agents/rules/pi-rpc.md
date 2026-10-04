# pi_rpc rules — apply to src-tauri/src/pi_rpc/** and any transport code

`pi_rpc` implements Pi's `--mode rpc` JSONL protocol, mirrored from the pinned
Pi checkout. Fidelity over elegance: this module is Pi's protocol wearing Rust
types, nothing more.

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
- Any change to protocol types MUST update the recorded JSONL fixtures
  (conformance corpus from a real `pi --mode rpc`) in the same change.

## Runtime rules

- One read loop per connection; fan out through a channel. NEVER block the read
  loop on UI or command handling — Pi relies on stdout backpressure.
- Correlate `id`s in a map; one in-flight request per id; `success: false`
  responses become an error the app reports as `PieError::Rpc`, never a panic.
- Lifecycle: closing stdin is the graceful shutdown path; handle SIGTERM and
  channel EOF; the SSH case follows the same rules over the russh channel.
- Check `pi --version` against the pin; a mismatch is surfaced as
  `PieError::Process`, not a silent continue.
- SSH specifics: `russh` with the `ring` crypto backend (Android cross-compile);
  host-key verification is ours to implement (TOFU + known_hosts); private keys
  cross the boundary as text, never as a path to a file — pie copies no secret
  material into its own storage. The frontend turns a file into text, because a
  picked file is a `content://` URI on Android rather than a path at all.
