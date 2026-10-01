# Recorded protocol fixtures

Real stdout of `pi --mode rpc`, recorded from the pinned Pi release.
`tests/conformance.rs` replays every record through the mirrored types; when a
protocol type changes, re-record these files in the same change, and keep what
each run reached in the corpus. `derived-supplement-0.99.2.jsonl` is the one
exception: it is hand-derived, and its section below says from what and why.

## Provenance

| file                              | recorded   | pi version | what the run did                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-probe-0.99.2.jsonl`      | 2026-10-01 | 0.99.2     | `--no-session`, fed `get_state`, `get_available_thinking_levels`, `get_commands`, `get_session_stats`, `get_messages`, `get_tree`, `get_last_assistant_text`, `set_steering_mode`, `set_follow_up_mode`, `get_fork_messages`, an unknown command, and one unparseable line                                                                                                     |
| `bash-session-0.99.2.jsonl`       | 2026-10-01 | 0.99.2     | `--no-session`, fed `set_session_name`, `bash` (still running at shutdown), `get_entries`, `get_session_stats`, `get_tree`, `clear_queue`, `abort_bash`, `get_state`                                                                                                                                                                                                           |
| `model-probe-0.99.2.jsonl`        | 2026-10-01 | 0.99.2     | `--no-session`, fed `get_available_models`, `set_thinking_level` (`off`, then an invalid value), `get_state`, `cycle_thinking_level`                                                                                                                                                                                                                                           |
| `transcript-0.99.2.jsonl`         | 2026-10-01 | 0.99.2     | `set_model` (`openrouter`, `stealth/space-bunny-alpha`), `set_thinking_level` `max`, a prompt answered with a `bash` tool call, then `get_messages`, `get_entries`, `get_session_stats`                                                                                                                                                                                        |
| `tour-0.99.2.jsonl`               | 2026-10-01 | 0.99.2     | `--session-dir`, streaming `bash` runs (one aborted), a prompt that is steered, followed up and then aborted, then `clear_queue`, `get_state`, `get_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `get_fork_messages`, `cycle_model`, `cycle_thinking_level`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `clone`, `export_html`, `new_session` |
| `branch-0.99.2.jsonl`             | 2026-10-01 | 0.99.2     | `--no-session`, two prompts, a manual `compact`, `get_entries` (showing the appended `compaction` entry), `get_fork_messages`, `fork` from a reported entry, a third prompt on the new branch, then `get_entries`, `get_tree`, `get_messages`, `get_session_stats`, `export_html`                                                                                              |
| `failures-0.99.2.jsonl`           | 2026-10-01 | 0.99.2     | `--no-session`, `set_auto_retry`/`set_auto_compaction`, `set_model` with a model outside the catalog (refused), a prompt, `get_messages`, a `compact` that cannot run, `get_entries`, `get_state`                                                                                                                                                                              |
| `session-0.99.2.jsonl`            | 2026-10-01 | 0.99.2     | `--session-dir`, `set_session_name`, a `bash` run, `get_state`, `switch_session` back into that file, `get_entries`, `get_session_stats`, `get_tree`, `get_last_assistant_text`, `export_html`, `clear_queue`, `cycle_model`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `clone`, `new_session`, `get_state`                                                      |
| `derived-supplement-0.99.2.jsonl` | -          | 0.99.2     | not recorded - see the section below                                                                                                                                                                                                                                                                                                                                           |

## Recording

A static pipeline reaches only what it sends up front, and stdin has to stay
open until a run settles - closing it early shuts pi down mid-stream:

```sh
{ printf '%s\n' '{"id":"1","type":"get_state"}' ...; sleep 30; } \
  | pi --mode rpc --no-session > recorded.jsonl
```

Situations that need a reaction - fork by an entry id that only exists at
runtime, steer or abort mid-run, answer a dialog pi opens - use `record.mjs`
from `tests/scripts`, a small driver that speaks the protocol and writes pi's
stdout verbatim:

```sh
node src-tauri/tests/scripts/record.mjs tour /tmp/tour.jsonl
```

Then install the raw recording with `install-recording.mjs` from the same
directory, which sanitizes and trims it (below) and prints what it contains:

```sh
node src-tauri/tests/scripts/install-recording.mjs /tmp/tour.jsonl tour-0.99.2.jsonl
```

The test double and the recording tools live in `tests/scripts`, not here: a
recording is data, and the files below cannot answer a request a test sends now.
See `tests/scripts/README.md`.

## Sanitization and trimming

Only opaque values are replaced, never structure, keys or types:

- `/home/<user>` paths are rewritten to `/home/user`, and session ids to a fixed
  UUID;
- the 589-entry `get_available_models` payload in `model-probe` keeps its first
  three entries (the element schema is what that fixture is for; the full list
  would have added 337 KB);
- in the fixtures recorded after it, the harness prompt is trimmed: strings
  longer than 120 characters are cut to 120 plus `…`, a `sections` map keeps its
  first two entries, and `toolsAdded`/`toolsRemoved` keep their first two
  elements. One recording was 512 KB of repeated prompt before this.

Records, session entries, messages, content parts and every other array length
are left alone: trimming those deletes the shapes the fixtures exist for. An
earlier, blunter rule silently dropped the `compaction` entry of `branch` this
way, which is why the rule is spelled out here.

## Supplement corpus

`derived-supplement-0.99.2.jsonl` is **not** recorded: it is hand-written from
the pinned checkout, because some shapes still have no recording. They come from

- `packages/coding-agent/src/modes/rpc/rpc-types.ts` - the `extension_error`
  record,
- `packages/coding-agent/src/modes/json-event.ts` with the `AgentSessionEvent`
  it derives from (`packages/coding-agent/src/core/agent-session.ts`) - the
  events,
- `packages/ai/src/types.ts` - the message and content-part types,
- `packages/coding-agent/src/core/messages.ts` - the app's extra message roles,
  and
- `packages/coding-agent/src/core/session-manager.ts` - the session entries.

It holds exactly what no recording reached: the `done` and `error` deltas, an
image part, `sections` with a removed (`null`) entry plus `toolsRemoved`, a tool
result with `details`, `usage` and `nestedCalls`, the signature fields
(`textSignature`, `thinkingSignature`, `thoughtSignature`, `namespace`,
`providerThinkingLevel`, `endTurn`), a nested tool execution carrying
`parentToolCallId`, an aborted compaction (`aborted: true`), the auto-retry and
summarization-retry events, and `extension_error`. Replace each shape with
recorded data as soon as a run produces it, and keep the rest in step with the
types.

## What the corpus pinned down

- Records arrive out of order relative to the commands that caused them, and
  events interleave with responses - a client must correlate, never assume
  order.
- An unknown command is echoed back verbatim with `success: false`, so the
  `command` field is an open string, not a closed enum.
- An unparseable line gets `{"command":"parse","success":false}` with **no**
  `id`.
- `get_last_assistant_text` answers `data: {}` - pi omits `text` rather than
  sending `null`.
- `setStatus` omits `statusText` when the status is cleared.
- `get_available_thinking_levels` answers `["off","low","high","max"]`, wider
  than the `ThinkingLevel` type pi's own `rpc-types.ts` annotates;
  `set_thinking_level` with `off` succeeds, and `thinking_level_changed` carries
  `"off"` too - so a session level is a `ModelThinkingLevel`.
- `set_thinking_level` with an invalid value (`"bogus"`) also answers
  `success: true`: pi does not validate the level. The mirrored type stays the
  closed `ModelThinkingLevel`, because that is the value space pi documents.
- `set_thinking_level` with `max` produced two `thinking_level_changed` events
  (`max`, then `high`) and the assistant message reported
  `thinkingLevel: "high"`: the level pi reports is the one it resolved, not
  necessarily the one requested.
- A catalog model entry carries `"type":"chat"`; the `get_state` projection
  omits `type` entirely.
- `get_state`'s model spells unsupported thinking levels out as `null`
  (`"medium":null`), while a catalog entry omits those keys instead. Both mean
  "unsupported", which is why `ThinkingLevelMap` keeps absent and `null` apart.
- A recorded system message carries `content: ""` and puts the whole prompt into
  `sections`, plus the tool schemas in `toolsAdded` - and the same message
  repeats in every record that carries the transcript.
- A message role can come from the app, not the core: the coding agent adds
  `bashExecution`, `custom`, `branchSummary` and `compactionSummary` by TS
  declaration merging, and a recorded `get_messages` contains a `bashExecution`
  one. That is why `every_recorded_payload_decodes` exists - the envelope check
  alone cannot see a payload like this.
- A plain tool result carries only `content`, `isError`, `toolCallId`,
  `toolName` and `timestamp` - no `details`, `usage` or `nestedCalls`.
- A real user message carries `content` as parts, never as a bare string.
- A killed `bash` reports `cancelled: true` and **omits** `exitCode`.
- `steer` and `follow_up` during a run answer `disposition: "queued"` and are
  reported back through `queue_update`.
- `fork` accepts only the ids `get_fork_messages` reports; any other entry id is
  refused with `Invalid entry ID for forking`.
- A compaction that could not run answers `success: false` and reports the
  reason on `compaction_end` as `aborted: false` plus `errorMessage` - not as an
  abort. After a successful one, pi appends the `compaction` entry right after
  `compaction_end`, so a `get_entries` sent with the response sees it.
- `set_model` validates against the catalog: an unknown id answers
  `Model not found: <provider>/<id>`.
- Extensions write `custom` session entries (`customType` plus raw `data`), and
  pi emits `notify` extension UI requests while tools run.
- `done` and `error` never appeared in 300+ recorded records of this release:
  RPC mode forwards `start`, `*_delta` and `*_end` only. A `branchSummary` entry
  never appeared either, although a fork and a prompt on the new branch were
  recorded.
