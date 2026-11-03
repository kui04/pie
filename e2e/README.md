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
  `/home/pi/.pi/agent/sessions/--home-pi-work--/`. The entrypoint copies them
  once to `sessions.seed`; the runner restores that snapshot before every case.

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
e2e/reset-host.sh       # restore the fixture snapshot
docker compose -f e2e/compose.yaml down -v
```

Both runners restore the host fixtures before every case and check the ones the
case declares in `fixtures`. `--no-reset` (Android) and `PIE_E2E_NO_RESET=1`
(Linux) skip the restore, to inspect the state a case left. Options:

```sh
pnpm e2e:android -- --cases P0         # only the blocking cases
pnpm e2e:android -- --cases CONN-02,RUN-07
pnpm e2e:android -- --serial 192.168.240.112:5555
pnpm e2e:linux -- --cases CONN-01      # one case, on Linux
pnpm e2e:linux -- --tags run
```

Both platforms take the same `--cases`, `--tags`, and `--priority` filters.
`--serial` is Android-only. The Linux spec reads the filters from
`PIE_E2E_CASES`, `PIE_E2E_TAGS`, and `PIE_E2E_PRIORITY`, which `run.sh` sets.

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
DevTools Protocol. The Linux suite uses WebdriverIO; its config starts
`tauri-driver` and `WebKitWebDriver` under Xvfb, then sets the window to 800x600
so the narrow layout is tested. Both runners select the same case registry and
start every case on a fresh app-data sandbox (the Linux XDG sandbox, the Android
`pm clear`) and on the restored host fixtures. A debug build enables the Android
WebView devtools bridge in wry; no package is added.

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
sessions are recorded with the real model; that costs a few calls. The real host
is not restored between cases: its conversations grow with the run, and SESS-01
does not assert their order.

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

The catalog is [CASES.md](CASES.md). It lists the host checks, the automatic
behavior cases, and the manual cases. Android and Linux run the same 19
automatic cases from one registry; `platforms` decides where each case runs. Add
a case to the catalog first; this file explains how to run it.

The mock suite has 19 automatic cases and 17 manual cases on both platforms.
`pnpm e2e:real` has five structural checks against a separate real-provider
host; see above.

## Last run

2026-11-03: the Android suite passed 19/19 and the Linux desktop suite passed
19/19 against the mock host. The real smoke passed 5/5 against Ollama Cloud
`beam` through a custom `models.json` provider: four answers, 13,611 tokens.
Waydroid's adb refuses `run-as`, so the SEC-01 app-data half runs only where adb
can enter the package; the logcat half runs everywhere. On Linux, SEC-01 reads
the driver log and the XDG sandbox instead.

## The report

Both runs write `report.json` under `e2e/.artifacts/<timestamp>/`. A report
holds one record per case (`id`, `priority`, `name`, `status`, `error`, `ms`),
the run (`platform`, `profile`, `address`), and a `summary`. Failure screenshots
sit in `screens/`, named by case ID. The Android run also writes `logcat.txt`;
the Linux run also prints the spec reporter. Both commands exit non-zero when a
case fails.

## Layout

```
e2e/
  CASES.md           the case catalog and platform coverage
  compose.yaml        host and mock
  compose.real.yaml   the real-provider host on 2223
  real.env.example    the values to fill; the key stays in .testenv
  setup.sh            test SSH keys and the host fingerprint
  verify-host.sh      ENV-01..09
  verify-real.sh      the real host checks
  reset-host.sh       restore the fixture snapshot on the host
  run.sh              the fixed flow
  host/               Dockerfile, sshd, and both pi configurations
  mock/               the deterministic OpenAI-compatible endpoint
  lib/                the RPC and mock checks the shell scripts call
  cases/              all case definitions and metadata
    index.mjs         the single registry
    connection.mjs    CONN
    sessions.mjs      SESS
    run.mjs           RUN and UI
    management.mjs    MGMT
    errors.mjs        ERR
    security.mjs      SEC
    real.mjs          the real-provider profile
  pages/              platform-neutral gate, sidebar, session, and composer actions
  apps/               the app interface and the Linux and Android adapters
  support/            host, sandbox, Xvfb, driver, artifacts, report, DOM fills, and case selection
  runners/android/    run.mjs, env.mjs, cdp.mjs (transport)
  runners/linux/      wdio.conf.mjs, specs/
  .testenv/           generated keys (ignored)
  .artifacts/         reports (ignored)
```
