# e2e

Two debug builds drive a Docker host that runs pi 1.1.0 over SSH: the Android
APK and the Linux desktop binary. No application code takes part: both are
normal debug builds, and the host is a plain machine with pi on `PATH`.

## Rules

- Add a case to `CASES.md` before you write it. The catalog holds its ID,
  platform, automation, and priority; `cases/index.mjs` is the one registry both
  runners read, and `platforms` decides where a case runs.
- A change under `e2e/` is checked by `pnpm e2e:env` and by the platform run
  that can fail for it. Both need Docker; Android also needs the device.
- Do not add a test-only path to the app. The environment uses a debug build as
  it is; the Android WebView devtools bridge in wry is the only thing a debug
  build turns on.
- Keep the mock scripted: a new reply is a new prompt prefix in `mock/`, never a
  live model.
- Never commit `.testenv/` or `.artifacts/`; both are ignored, and the real key
  stays in `.testenv/real.env`.

## The host

- `host`: `node:22-bookworm-slim` with `openssh-server` and pi 1.1.0 from npm.
  User `pi`, password `pie-test`, and the key in `.testenv/ssh/`.
- The SSH host key comes from `.testenv/ssh/host_ed25519`, so its fingerprint
  survives a rebuild and the app keeps its `known_hosts`.
- `mock`: an OpenAI-compatible endpoint with no credential. One scripted reply
  per prompt prefix: `hello` (text), `tool` (a bash call, then a final text),
  `wait` (a silent pause), `slow` (a long stream), `ask` (an `ask_user` call,
  then a final text that quotes the answer).
- pi configuration: `defaultProvider` `pie-e2e`, `defaultModel` `mock-echo` (and
  `mock-alt`), `defaultThinkingLevel` `low`; packages `pi-ask-user` 0.17.2 and
  `pi-permission-system` 0.8.0. The permission system runs with `yoloMode`, so
  it does not stop every tool call; the prompt is stage 2.
- Fixtures: two sessions recorded against the mock (`hello`, `tool`) under
  `/home/pi/.pi/agent/sessions/--home-pi-work--/`. The entrypoint copies them
  once to `sessions.seed`; the runner restores that snapshot before every case.
- The build uses `network: host`: this machine's default Docker bridge has no
  outbound NAT, so a normal build cannot reach npm or Debian.
- `models.dev` answers an unknown provider with one placeholder mark; pie treats
  it as no mark and draws its bot icon. A real provider keeps its own logo.

## The flow

```sh
e2e/setup.sh            # once, idempotent: test SSH keys and the host fingerprint
pnpm e2e:env            # build the host, bring it up, check ENV-01..09
pnpm e2e:android        # install the debug APK, run the Android cases
pnpm e2e:linux          # build and drive the Linux desktop binary
pnpm e2e                # env + Android
pnpm e2e:real           # the real-provider host, then the Android runner on it
e2e/reset-host.sh       # restore the fixture snapshot
docker compose -f e2e/compose.yaml down -v
```

Both runners restore the host fixtures before every case and check the ones the
case declares in `fixtures`. `--no-reset` (Android) and `PIE_E2E_NO_RESET=1`
(Linux) skip the restore, to inspect the state a case left. Filters:

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
`pm clear`) and on the restored host fixtures.

## The real model

The mock suite is the regression gate. A second host can run a real provider for
acceptance, beside the mock host:

1. `cp e2e/real.env.example e2e/.testenv/real.env` and fill in the provider,
   model, thinking level, and key. Pick a level the model supports; pi clamps an
   unsupported level, and `verify-real.sh` reports the clamp.
2. `pnpm e2e:real`.

The real host listens on `pi@192.168.240.1:2223`; the mock host stays on 2222.
It runs with the host network, for the same NAT reason. Its container is
recreated on every real run, and its fixture sessions are recorded with the real
model, so a run costs a few calls. The real host is not restored between cases:
its conversations grow with the run, and SESS-01 does not assert their order.

The key is written to `.testenv/real.key` (mode 600), mounted as a Docker
secret, and copied to a pi-owned file inside the container. It does not enter
the image, the repository, the app, or a log. `docker rm -f pie-e2e-host-real-1`
removes the container and its copy.

The automatic real cases assert structure only: the gate, the list, the provider
mark, a seeded conversation, and one short answer that the conversation file
records. The model's words are not an oracle. Keep the rest for the manual
checklist in `CASES.md`: switch the model, change the thinking level, ask for a
bash call, answer an `ask_user` prompt, allow and deny a tool, attach an image,
stop a run, and drop the link. The real profile stays Android-only.

A custom OpenAI-compatible endpoint adds `PIE_E2E_BASE_URL`, with `PIE_E2E_API`
(default `openai-completions`) and `PIE_E2E_REASONING=1` when the model thinks.
The host then writes `models.json` instead of `auth.json`; the key handling does
not change. The provider id is yours to choose.

## The cases

`CASES.md` is the catalog: the host checks, the automatic behavior cases, and
the manual cases. Android and Linux run the same automatic cases from one
registry; a truly platform-specific case names only its platforms. Add a case to
the catalog first; this file explains how to run it.

## The report

Both runs write `report.json` under `e2e/.artifacts/<timestamp>/`. A report
holds one record per case (`id`, `priority`, `name`, `status`, `error`, `ms`),
the run (`platform`, `profile`, `address`), and a `summary`. Failure screenshots
sit in `screens/`, named by case ID. The Android run also writes `logcat.txt`;
the Linux run also prints the spec reporter. Both commands exit non-zero when a
case fails.

## The layout

- `cases/`: the registry and its modules, one per behavior group (`CONN`,
  `SESS`, `RUN` and `UI`, `MGMT`, `ERR`, `SEC`), plus `real.mjs` for the
  real-provider profile.
- `pages/`: platform-neutral gate, sidebar, session, and composer actions.
- `apps/`: the app interface and the Linux and Android adapters.
- `support/`: host, sandbox, Xvfb, driver, artifacts, report, DOM fills, and
  case selection.
- `runners/android/`: `run.mjs`, `env.mjs`, and `cdp.mjs`, the WebView
  transport.
- `runners/linux/`: the WebdriverIO config and its specs.
- `host/` and `mock/`: the Dockerfile, sshd, both pi configurations, and the
  deterministic endpoint.
- `compose.yaml` and `compose.real.yaml`: the mock and real hosts.
- `run.sh`, `setup.sh`, `verify-host.sh`, `verify-real.sh`, `reset-host.sh`: the
  fixed flow and its checks.
