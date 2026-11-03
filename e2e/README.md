# End-to-end tests

The suite drives two debug builds against a Docker host that runs pi 1.1.0 over
SSH: the Android APK and the Linux desktop binary. It writes a report under
`e2e/.artifacts/`.

No application code takes part in the test environment: both are normal debug
builds, and the host is a plain machine with pi on `PATH`.

## The test host

- `host`: `node:22-bookworm-slim` with `openssh-server` and pi 1.1.0 from npm.
  User `pi`, password `pie-test`, and the key in `.testenv/ssh/`.
- The SSH host key comes from `.testenv/ssh/host_ed25519`, so its fingerprint is
  the same across rebuilds and the app keeps its `known_hosts`.
- `mock`: an OpenAI-compatible endpoint with no credential. It scripts one reply
  per prompt prefix: `hello` (text), `tool` (a bash call, then a final text),
  `wait` (a silent pause), `slow` (a long stream), `ask` (an `ask_user` call,
  then a final text that quotes the answer).
- pi configuration: `defaultProvider` `pie-e2e`, `defaultModel` `mock-echo` (and
  `mock-alt`), `defaultThinkingLevel` `low`; packages `pi-ask-user` 0.17.2 and
  `pi-permission-system` 0.8.0. The permission system runs with `yoloMode`, so
  it does not stop every tool call; the prompt is stage 2.
- Fixtures: two real sessions recorded against the mock (`hello`, `tool`), under
  `/home/pi/.pi/agent/sessions/--home-pi-work--/`.

`models.dev` answers an unknown provider with one placeholder mark; pie treats
it as no mark and draws its bot icon. A real provider keeps its own logo.

The build uses `network: host`: this machine's default Docker bridge has no
outbound NAT, so a normal build cannot reach npm or Debian.

## Fixed flow

```sh
e2e/setup.sh            # once, idempotent: test SSH keys and the host fingerprint
pnpm e2e:env            # build the host, bring it up, check ENV-01..09
pnpm e2e:android        # install the debug APK, run the Android cases
pnpm e2e:linux          # build and drive the Linux desktop binary
pnpm e2e                # env + Android
pnpm e2e:real           # bring up the real-provider host and run its smoke
e2e/reset-host.sh       # put the host back to the two fixtures
docker compose -f e2e/compose.yaml down -v
```

The runner resets the host by itself unless `--no-reset` is passed. Options:

```sh
pnpm e2e:android -- --cases P0         # only the blocking cases
pnpm e2e:android -- --cases CONN-02,RUN-07
pnpm e2e:android -- --serial 192.168.240.112:5555
pnpm e2e:linux -- --cases L-01         # one Linux smoke case
```

Prerequisites:

- The debug APK at
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
  Build it inside devenv:
  `devenv shell -- bash -lc "pnpm tauri android build --target x86_64 --debug --apk"`.
- The device serial in `PIE_ANDROID_SERIAL` (default `192.168.240.112:5555`, the
  Waydroid address), and the one-time "Allow USB debugging" tap on the device.
- `adb`, `docker`, `ssh`, `node`.
- Linux desktop: `tauri-driver` (`cargo install tauri-driver --locked`),
  `WebKitWebDriver` (from webkitgtk), and `Xvfb` (from devenv). It uses the same
  Docker host and needs no APK or adb.

The Android driver reads the WebView through `adb forward` and the Chrome
DevTools Protocol. The Linux driver starts `tauri-driver` and `WebKitWebDriver`
under Xvfb, then sets the window to 800x600 so the narrow layout is tested. A
debug build enables the Android WebView devtools bridge in wry; no package is
added.

## Real model

The mock suite is the regression gate. A second host can run a real provider for
acceptance, beside the mock host:

1. `cp e2e/real.env.example e2e/.testenv/real.env` and fill in the provider,
   model, thinking level, and key. Pick a level the model supports; pi clamps an
   unsupported level, and `verify-real.sh` reports the clamp.
2. `pnpm e2e:real`.

The real host listens on `pi@192.168.240.1:2223`; the mock host stays on 2222.
It runs with the host network, because this machine's Docker bridge has no
outbound NAT. Its container is recreated on every real run, so its two fixture
sessions are recorded with the real model; that costs a few calls.

The key is written to `.testenv/real.key` (mode 600), mounted as a Docker
secret, and copied to a pi-owned file inside the container. It does not enter
the image, the repository, the app, or a log. `docker rm -f pie-e2e-host-real-1`
removes the container and its copy.

The automatic real cases assert structure only: the gate (CONN-01), the list
(SESS-01), the provider mark (REAL-ICON), a seeded conversation (REAL-OPEN), and
one short answer that the conversation file records (REAL-SEND). The model's
words are not an oracle. Keep the rest for the manual checklist: switch the
model, change the thinking level, ask for a bash call, answer an `ask_user`
prompt, allow and deny a tool, attach an image, stop a run, and drop the link.

A custom OpenAI-compatible endpoint adds `PIE_E2E_BASE_URL`, with `PIE_E2E_API`
(default `openai-completions`) and `PIE_E2E_REASONING=1` when the model thinks.
The host then writes `models.json` instead of `auth.json`; the key handling does
not change. The provider id is yours to choose for a custom endpoint.

## Cases

`auto` cases run in `e2e/android/run.mjs` and `e2e/linux/run.mjs`. The rest are
stage 2.

### Host, checked by `e2e/verify-host.sh`

| ID     | What                                                             | Stage |
| ------ | ---------------------------------------------------------------- | ----- |
| ENV-01 | mock answers `/health`, host becomes healthy                     | auto  |
| ENV-02 | password and key SSH, `pi --version` = 1.1.0 on a non-login PATH | auto  |
| ENV-03 | the test key is accepted, a key outside `authorized_keys` is not | auto  |
| ENV-04 | the host key fingerprint is the same after a rebuild             | auto  |
| ENV-05 | `pi --mode rpc` over SSH answers `get_state`                     | auto  |
| ENV-06 | `pie-e2e`, `mock-echo`, and the thinking levels resolve          | auto  |
| ENV-07 | both packages are installed, with no npm at run time             | auto  |
| ENV-08 | the two fixtures are on the host, with `cwd=/home/pi/work`       | auto  |
| ENV-09 | the mock is deterministic and scripts hello, tool, and ask       | auto  |

### App, on the Android device

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
| SEC-01  | no password reaches logcat (app data where adb can read it)           | auto   |
| SEC-02  | a trusted host key is kept across a restart                           | auto   |
| SEC-03  | pie writes no file on the host                                        | manual |
| NF-01   | cold start to the gate, and connect to the list, stay within budget   | manual |
| NF-02   | 360px stays usable, and every control has a name                      | manual |

### App, on the Linux desktop

| ID   | What                                                                      | Stage |
| ---- | ------------------------------------------------------------------------- | ----- |
| L-01 | a cold desktop app connects, trusts the host key, and lists both fixtures | auto  |
| L-02 | a message streams an answer and lands in the session file                 | auto  |
| L-03 | a restart remembers the host but keeps no credential                      | auto  |
| L-04 | a rejected password says so and leaves the gate usable                    | auto  |

## Last run

2026-11-03: the Linux desktop suite passed 4/4 against the mock host. The
2026-11-02 Android run passed 19/19. The real smoke passed 5/5 against Ollama
Cloud `beam` through a custom `models.json` provider: four answers, 13,611
tokens. Waydroid's adb refuses `run-as`, so the SEC-01 app-data half runs only
where adb can enter the package; the logcat half runs everywhere.

## The report

`e2e/.artifacts/<timestamp>/report.json` holds one record per case (status,
error, duration), and `screens/` holds the screenshot of each failure. The
Android run also writes `logcat.txt`; the Linux run writes the app's stderr to
the terminal. The command exits non-zero when a case fails.

## Layout

```
e2e/
  compose.yaml        host and mock
  compose.real.yaml   the real-provider host on 2223
  real.env.example    the values to fill; the key stays in .testenv
  setup.sh            test SSH keys and the host fingerprint
  verify-host.sh      ENV-01..09
  verify-real.sh      the real host checks
  reset-host.sh       the two fixtures, back again
  run.sh              the fixed flow
  host/               Dockerfile, sshd, and both pi configurations
  mock/               the deterministic OpenAI-compatible endpoint
  lib/                the RPC and mock checks the shell scripts call
  android/            cdp.mjs (the driver), run.mjs (the cases)
  linux/              webdriver.mjs (the driver), run.mjs (the cases)
  .testenv/           generated keys (ignored)
  .artifacts/         reports (ignored)
```
