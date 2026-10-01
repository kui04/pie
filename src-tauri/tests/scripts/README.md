# Test scripts

Tooling that supports the protocol tests. None of it is part of a test run:
`cargo` ignores a `tests/` subdirectory without a `main.rs`, so these are only
ever started by hand or by `tests/local_pi.rs`.

## `fake-pi.sh` - the scripted peer

```sh
# started by the test itself, not by hand:
#   LocalTransport::new("bash").arg(script("fake-pi.sh"))
```

A ~25 line bash loop that stands in for `pi --mode rpc`: it reads JSONL from
stdin, correlates by `id`, answers `get_state` and `bash` (sending a
`bash_execution_update` before the response, as pi does), exits 0 when stdin
closes, and answers anything unexpected with an error response so a test that
sends a new command fails with a message instead of hanging.

It exists because the transport tests need a **live** peer: a recorded fixture
is data and cannot answer a request a test sends now. It is the only coverage of
`LocalTransport` in the default run - the real-`pi` test next to it is
`#[ignore]`d - and it is what caught `AsyncWrite::shutdown` being a no-op for
`tokio::process::ChildStdin`.

## `record.mjs` - record a session

```sh
node src-tauri/tests/scripts/record.mjs <reasoning|session|tour|failures> <out.jsonl>
```

Spawns `pi --mode rpc` and writes its stdout **verbatim** to `out.jsonl`, while
reacting to what pi sends - which is what reaches situations a static pipeline
cannot: forking by an entry id that only exists at runtime, steering or aborting
mid-run, and answering the dialogs pi opens so a run never stalls on one.

| scenario    | what it drives                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning` | two prompts, a manual `compact`, `get_entries` + `get_fork_messages`, a `fork` from a reported entry, a prompt on the new branch, then the reporting commands                                     |
| `tour`      | streaming `bash` runs (one aborted), a prompt that is steered, followed up and aborted, then the session commands (`clear_queue`, `cycle_*`, `set_auto_*`, `clone`, `export_html`, `new_session`) |
| `session`   | session commands only and no model calls: `set_session_name`, `bash`, `get_state`, `switch_session`, `export_html`, `clone`, `new_session`                                                        |
| `failures`  | a model outside the catalog (refused), a prompt, then a `compact` that cannot run                                                                                                                 |

The output is a raw recording: it still holds local paths, the session id and
the whole harness prompt, and it is not yet a fixture. Sanitize it first
(below).

## `install-recording.mjs` - turn a recording into a fixture

```sh
node src-tauri/tests/scripts/install-recording.mjs /tmp/tour.jsonl tour-0.99.2.jsonl
```

Reads a raw recording, sanitizes it, trims the harness prompt, writes
`src-tauri/tests/fixtures/<fixture-name.jsonl>`, and prints what ended up in
there (record count, per-kind counts, session entry types). The trimming rules
and their rationale - including why entries are never trimmed - are in
`../fixtures/README.md`, next to the corpus they produce.

A session that needs no reaction can equally be recorded with a plain pipeline:

```sh
{ printf '%s\n' '{"id":"1","type":"get_state"}' ...; sleep 30; } \
  | pi --mode rpc --no-session > /tmp/raw.jsonl
```
