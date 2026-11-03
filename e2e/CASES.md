# End-to-end case catalog

This is the list of E2E cases and their platform coverage. The setup, commands,
and reporting format are in [`README.md`](README.md); the layer rules are in
[`../TESTING.md`](../TESTING.md).

An ID names a behavior, not a file. An automatic case runs on every platform
named by its `platforms` metadata. Android and Linux run the same automatic
behavior cases; the real-provider profile stays Android-only.

Every automatic case starts from the recorded host fixtures. The runner restores
the snapshot and checks the fixtures the case declares before it runs;
`fixtures: []` means the case reads none. The real host keeps its state.

## Host

Checked by `e2e/verify-host.sh`.

| ID     | What                                                                          | Automation |
| ------ | ----------------------------------------------------------------------------- | ---------- |
| ENV-01 | mock answers `/health`, host becomes healthy                                  | auto       |
| ENV-02 | password and key SSH, `pi --version` = 1.1.0 on a non-login PATH              | auto       |
| ENV-03 | the test key is accepted, a key outside `authorized_keys` is not              | auto       |
| ENV-04 | the host key fingerprint is the same after a rebuild                          | auto       |
| ENV-05 | `pi --mode rpc` over SSH answers `get_state`                                  | auto       |
| ENV-06 | `pie-e2e`, `mock-echo`, and the thinking levels resolve                       | auto       |
| ENV-07 | both packages are installed, with no npm at run time                          | auto       |
| ENV-08 | the two fixtures and their snapshot are on the host, with `cwd=/home/pi/work` | auto       |
| ENV-09 | the mock is deterministic and scripts hello, tool, and ask                    | auto       |

## App cases

The automatic cases are the behavior modules under `e2e/cases/`. The Android
runner and the Linux WebdriverIO spec both select them from the same registry by
`platforms`. Rows with **Stage** `manual` are the manual checklist.

| ID      | What                                                                  | Stage  |
| ------- | --------------------------------------------------------------------- | ------ |
| CONN-01 | a cold app opens the gate at local, and names the missing address     | auto   |
| CONN-02 | a rejected password says so and leaves the gate usable                | auto   |
| CONN-03 | the host key is shown with its fingerprint, refused, then trusted     | auto   |
| CONN-04 | a restart remembers the host, not the credential                      | auto   |
| CONN-05 | a private key opens the host                                          | auto   |
| CONN-06 | an encrypted key refuses a wrong passphrase and accepts the right one | auto   |
| CONN-07 | a changed host key is not accepted silently                           | manual |
| SESS-01 | the list shows both fixtures, newest first, under `~/work`            | auto   |
| SESS-02 | a session opens as its file reads                                     | auto   |
| SESS-03 | an unknown record degrades to a general shape                         | manual |
| SESS-04 | a header-only session opens empty                                     | manual |
| SESS-05 | a 500-entry transcript opens and scrolls                              | manual |
| RUN-01  | a message streams an answer and lands in the session file             | auto   |
| RUN-02  | the picker lists both models, draws the mark, and records the change  | auto   |
| RUN-03  | the thinking level changes and the answer records it                  | auto   |
| RUN-04  | a tool call round-trips through the transcript                        | manual |
| RUN-05  | `!echo hi` runs on the host                                           | manual |
| RUN-06  | a slash command reaches pi and an unknown one does not crash          | manual |
| RUN-07  | Stop ends the run and leaves no pi behind                             | auto   |
| RUN-08  | an `ask_user` prompt answers and the run continues                    | auto   |
| UI-01   | the working ring turns while a run goes on                            | auto   |
| RUN-09  | a permission prompt allows and denies                                 | manual |
| RUN-10  | an image attachment uploads over SFTP                                 | manual |
| MGMT-01 | New session opens empty, then writes its first message                | auto   |
| MGMT-02 | Rename updates the menu and the file                                  | manual |
| MGMT-03 | Delete removes the conversation from the host                         | auto   |
| ERR-01  | a host without pi fails, and recovers when pi returns                 | manual |
| ERR-02  | another pi version still connects, with a warning in the log          | manual |
| ERR-03  | a stopped host is named, and Reconnect brings the link back           | auto   |
| ERR-04  | a malformed JSONL fixture degrades                                    | manual |
| ERR-05  | a restart during a connection leaves no duplicate row                 | manual |
| SEC-01  | no password reaches the app log or app data                           | auto   |
| SEC-02  | a trusted host key is kept across a restart                           | auto   |
| SEC-03  | pie writes no file on the host                                        | manual |
| NF-01   | cold start to the gate, and connect to the list, stay within budget   | manual |
| NF-02   | 360px stays usable, and every control has a name                      | manual |

## Linux desktop

Linux runs the same automatic behavior cases through
`e2e/runners/linux/specs/desktop.e2e.mjs`; there are no Linux-only smoke IDs.
The runner creates a fresh XDG sandbox and restores the host fixtures for every
case, like the Android runner's `pm clear`.

## Real-provider acceptance

The real suite has its own host and is structural. The model's words are not an
oracle. The real host is not restored between cases; its conversations grow with
the run. See [`README.md`](README.md#real-model).

| ID        | What                                               | Automation |
| --------- | -------------------------------------------------- | ---------- |
| CONN-01   | the real gate opens and connects                   | auto       |
| SESS-01   | the real list shows the seeded conversation        | auto       |
| REAL-ICON | the real provider mark is drawn                    | auto       |
| REAL-OPEN | a seeded conversation opens as it reads            | auto       |
| REAL-SEND | a real answer is recorded in the conversation file | auto       |

## Adding a case

1. Choose the behavior ID from the table above. Add a new prefix only for a new
   behavior family.
2. Add the executable case to `e2e/cases/` with its `platforms` metadata and the
   fixtures it reads (or `[]` when it reads none), and list it here.
3. If the behavior is truly platform-specific, name only those platforms; do not
   copy the case into a platform directory.
4. Run both platform commands and check the reports before committing.
