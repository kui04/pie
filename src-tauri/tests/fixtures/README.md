# Session fixtures

Real `pi` session files for the `session::store` and catalog unit tests. The
model's words are not an oracle: the tests assert the structure pi writes and
the prompt the test sent, never the answer text.

One file serves both the single-file scan and the catalog scan. Duplicating it
per test target would let the copies drift; the tables name the shape each file
covers instead.

## Mock

Recorded on the e2e mock host with `pie-e2e`/`mock-echo`.

| File                 | Shape                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `mock/hello.jsonl`   | one user turn, one assistant turn                                           |
| `mock/tool.jsonl`    | a bash tool call and its result                                             |
| `mock/renamed.jsonl` | an RPC `set_session_name` appends a tail `session_info`; the late name wins |
| `mock/forked.jsonl`  | a `pi --fork` child with `parentSession` and the copied user turns          |
| `mock/ask.jsonl`     | an `ask_user` tool call and its result                                      |

## Edge

Derived from `mock/hello.jsonl`; they do not spend a model call.

| File                      | Shape                                   |
| ------------------------- | --------------------------------------- |
| `edge/cleared-name.jsonl` | the tail `session_info` clears the name |
| `edge/header-only.jsonl`  | a session header with no messages       |
| `edge/truncated.jsonl`    | the last line is cut mid-record         |

## Real

Recorded on the real host with `ollama-cloud/beam` and `--thinking max` (pi
records `xhigh`, the highest level the model supports). The SWE-bench entries
have the public regression test patch applied and the gold patch absent. The
Terminal-Bench entry uses its official tests as the oracle.

| File                        | Benchmark                                  | Shape                                                               |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `real/axios-formdata.jsonl` | SWE-bench Multilingual `axios__axios-5316` | 143 lines, 68 bash calls; the target test prints `1 passing`        |
| `real/vue-vpre.jsonl`       | SWE-bench Multilingual `vuejs__core-11915` | 74 lines, 34 bash calls; 3 v-pre cases and 636 compiler tests pass  |
| `real/vue-watch.jsonl`      | SWE-bench Multilingual `vuejs__core-11589` | 64 lines, 29 read/bash calls; the target and 888 runtime tests pass |
| `real/vue-ssr.jsonl`        | SWE-bench Multilingual `vuejs__core-11739` | 82 lines, 38 read/bash calls; 90 hydration tests pass               |
| `real/regex-chess.jsonl`    | Terminal-Bench `regex-chess`               | 90 lines, 2 user turns, 42 calls; 4 official tests pass in 68.21s   |

Each long real session's only `session_info` sits at the head, beyond the 64 KiB
tail window, so the catalog tests expect `FromFirstPrompt` for these fixtures.

## Multi-turn

`real/kanban-frontend.jsonl` records a five-turn frontend project: a React,
TypeScript, and Vite Kanban board. After every turn we ran `npm test -- --run`
and `npm run build`; when they passed, the next prompt added the next feature. A
failing turn would have been sent back as the next prompt instead.

| Turn | Requirement                                                      | Result   |
| ---- | ---------------------------------------------------------------- | -------- |
| 1    | Core board, add/edit/move/delete, localStorage, tests            | 7 tests  |
| 2    | Drag-and-drop, search, priority filter, counts, empty states     | 12 tests |
| 3    | Undo/redo, keyboard shortcuts, input-focus guard, persistence    | 19 tests |
| 4    | Due dates, Overdue/Due today badges, Manual/Due/Priority sorting | 24 tests |
| 5    | Light/Dark/System theme, aria-live, responsive layout, README    | 27 tests |

The session has 5 user turns, 79 tool calls, and 173 lines; the final run prints
`27 passed` and the build is green. The full turn prompts are in the session.
The app itself lives at `/home/pi/work/kanban` on the e2e host; the fixture is
the recorded conversation, not the app source.

## Re-recording

- Mock: run `e2e/reset-host.sh` for `hello` and `tool`. For the rename, start a
  session and send `{"type":"set_session_name","name":"renamed"}` through
  `pi --mode rpc --session <path>`. For the fork, run `pi --fork <parent>`. For
  the ask, run `pi -n ask -p ask` with the mock script.
- Edge: copy `mock/hello.jsonl`, then clear the name, keep only the header, or
  cut the last line.
- Real SWE-bench: start the real host with `e2e/.testenv/real.env`, fetch the
  benchmark's base commit, apply its test patch, and install dependencies
  (`npm ci` plus `formdata-node` for axios;
  `corepack pnpm install --frozen-lockfile --ignore-scripts` for Vue). From the
  repository root, run `pi --thinking max` with the prompt that asks to make the
  new tests pass. Keep stdin closed (`ssh -n`) so pi does not wait for piped
  input. Copy the newest session file here.
- Real Terminal-Bench: fetch the task's `check.py`, `TASK.md`, and tests from
  `harbor-framework/terminal-bench-1`, put the solver files in `/app`, and run
  `pi --thinking max`. After the first attempt, give it the official test
  failure as a follow-up user turn and let it iterate against that test. The
  `regex-chess` fixture records exactly that two-turn feedback loop.
- Multi-turn: scaffold a Vite React TS app and install Vitest/Testing Library.
  For each turn, run `pi --session <path> --thinking max` with the next
  requirement, then run the tests and build. If they pass, choose the next
  feature; if they fail, make the failure the next prompt. The `kanban` fixture
  records five such turns.
