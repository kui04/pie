# AGENTS.md

## Project overview

Pie is a cross-platform GUI for [Pi](https://github.com/earendil-works/pi),
mobile first. Tauri 2: React 19 + TypeScript + Vite 8 frontend in `src/`, Rust
backend in `src-tauri/`, committed Android Gradle project in
`src-tauri/gen/android/` (only `gen/schemas` is ignored). Pi's wire protocol
lives in `pi_rpc` (https://github.com/kui04/pi_rpc), a crate of its own that
this app takes as a git dependency; the version tracks the Pi release.

Architecture: React does UI + UI state only; Rust owns all logic; Pi is driven
as `pi --mode rpc` (JSONL over stdio), local spawn or SSH exec — the machine
running Pi must have `pi` on PATH.

Pi's source is checked out at `.codegraph/.references/pi` (untracked, indexed by
CodeGraph via `codegraph.json`) — read it for real Pi APIs instead of guessing.
Pinned at `ed8b3bcc194c8263ec8bec3f337053ae73866da1` (main); recreate with
`git clone https://github.com/earendil-works/pi .codegraph/.references/pi` and
`git -C .codegraph/.references/pi checkout <hash>`.

## Architecture rules

Read and strictly follow the matching rule file BEFORE writing code — they are
contracts, not suggestions. Deviations require explicit user approval.

- Anything: `.agents/rules/architecture.md`
- `src-tauri/src/channel/**`, `src-tauri/src/host/**` or the `pi_rpc` crate:
  `.agents/rules/pi-rpc.md`
- `src/**` (React): `.agents/rules/frontend.md` and `.agents/rules/state.md`

## Setup

[devenv](https://devenv.sh) provides the environment; direnv auto-loads it on
`cd` (`.envrc`). It has Rust stable (rust-overlay, mold), pnpm, Node, the
Android SDK/NDK + JDK, Tauri Linux deps, `just`, and `just-lsp`.

- `pnpm install` once — `node_modules/` is not Nix-managed.
- `devenv update` after editing `devenv.yaml` inputs.
- Never edit `local.properties`, `.devenv/`, `.direnv/` — auto-generated.

## Build and test

Recipes via [just](https://github.com/casey/just) (`just --list`) — the recipes
are the source of truth for the commands themselves.

- Desktop: `just dev` (dev), `just build` (release); component preview:
  `just storybook` / `just storybook-build`. There is no frontend-only server:
  the app asks Rust which platform it is on before it draws anything, so a plain
  browser has nothing to show.
- Android: `just android-dev`, `just android-build` — needs a connected device,
  no AVD is provided.
- Rust: `just check`, `just clippy` (warnings are errors, all targets),
  `just rust-test`, `just doc` (rustdoc with warnings as errors, so a link to a
  private item fails instead of going unnoticed) — all inside `src-tauri`, where
  the app lives. Ignored tests start a real `pi`: run them with
  `cd src-tauri && cargo test -- --ignored` after bumping the pin, and
  `just ssh-test` for the SSH paths (the reach to a machine and the sessions of
  that machine over it), which brings up its own sshd in a container
  (`just ssh-fixture` to keep one running).
- JS: `just lint`, `just format`, `just test` — none of them typechecks; only
  `pnpm build` runs `tsc`.
- Frontend types of the protocol: `src/lib/rpc-protocol.ts` names them by
  aliasing pi's own published types (`@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-ai`, both dev dependencies). It is hand-written and
  reviewed with the `pi_rpc` crate it describes — a protocol change touches
  both, and `pnpm build` is what proves the alias still resolves.

Stories sit in their component's `__stories__/` folder
(`src/**/__stories__/*.stories.tsx`) and render from static args; the recorded
protocol corpus is decoded and asserted in `src-tauri/tests/conformance.rs`.
Statecharts are also path-enumerated with `@xstate/graph`
(`src/machines/__tests__/statechart-pattern.test.ts`).

## Git hooks

prek runs on commit (wired by devenv): nixfmt, prettier, eslint `--fix`,
rustfmt. Hooks may rewrite files — review the diff, `git add` again, re-commit.
Run all manually: `just hooks`. clippy is deliberately not a hook (it needs the
full devenv build env) — run `just clippy` before pushing.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary` — imperative, lowercase, no period. The subject states
the key point directly; add a body only for a non-obvious why. Types used here:
`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`.

## Conventions

- UI primitives come from shadcn with Radix
  (`pnpm dlx shadcn@latest add <name>`) into `src/components/ui/`, and stay the
  registry's files: never hand-edit one, so re-running the same command is the
  whole upgrade, and `just ui-check` fails when a file there has drifted. A
  difference belongs in a call site's `className` (through `cn`; a size that
  fights the app's own ramp is written `text-[length:var(--text-body-md)]`
  because `cn` reads `text-body-md` as a colour), in the theme in
  `src/index.css`, or in one of pie's own components beside `ui/` when the
  difference is structural (`src/components/{ScrollPane,Sheet,OptionRow}.tsx`).
  A primitive nothing in the app imports is not vendored: `scroll-area`,
  `drawer` and `dropdown-menu` were removed when pie's own components took their
  job. Every directory called `components/` has an `index.ts`, and that barrel
  is the only door a caller outside it uses - so a folder move does not touch a
  caller: a primitive from `@/components/ui`, pie's own from `@/components`, a
  route's own from `@/routes/<screen>/components` (`layout/` holds the window's
  frame and what keeps a region clear of the system bars). A file inside a
  folder imports its neighbours by path, so a barrel is never imported by a file
  it re-exports.
- The app layer keeps its own shape: `src-tauri/src/error.rs` is the boundary
  aggregation (`PieError`, holding the `pi_rpc` crate's error, `channel::Error`,
  `host::Error`, `session::Error` and `commands::Error` of the layer that
  failed, one `From` for each), `src-tauri/src/channel/` is one started program,
  `src-tauri/src/host/` is the machine pie reaches, `src-tauri/src/session/`
  holds its sessions (and stays free of Tauri, so it can be tested against a
  real machine), and `src-tauri/src/commands/` is the IPC surface — commands
  return `Result<T, PieError>`, events are `pi://<area>/{id}`, and each area has
  its own file, mirrored one to one by `src/lib/bridge/`.
- Errors: every layer names its own failures as a `thiserror` enum whose
  variants are what a caller matches on (`channel::Error` for the bytes of a
  program and the start of it, `host::Error` for the reach to a machine and what
  pie does on it, `session::Error`, `commands::Error`), and no layer wraps
  another's. `PieError` is the aggregation of them —
  `PieError::{Channel, Host, Session, Commands, Rpc, Io}`, one variant per
  module — carrying the module, the message the frontend reads, and the named
  variant underneath, so a new way to fail belongs in the layer that owns it and
  nothing is flattened on the way through. The protocol crate's own failures
  cross as one of its five kinds (`RpcFailure` in `src-tauri/src/error.rs`),
  because it is not serializable and its detail belongs in the log rather than
  on a screen.
- The frontend reaches no `@tauri-apps/plugin-*` npm package: Rust registers the
  plugin and exports a command, and the capability permission goes with the npm
  package. `no-restricted-imports` in `eslint.config.js` enforces it;
  `@tauri-apps/api` is the bridge itself and stays.
- `src-tauri/Cargo.toml` lists dependencies in alphabetical order, which
  `src-tauri/tests/manifest.rs` checks.
- A code comment states the reason inline and cites only what a reader outside
  this working tree can look up: the code, or a source that ships with a project
  (OpenSSH's or russh's own source, pi at the pinned version). `docs/` is a
  migration-period directory that is never committed, so no committed file may
  point into it — a comment that needs backing names the source and the fact it
  establishes, never a path that resolves only here.
- Version tracks the latest
  [Pi release](https://github.com/earendil-works/pi/releases) (currently 1.1.0).
  When bumping: edit `package.json`, `src-tauri/tauri.conf.json` and
  `src-tauri/Cargo.toml`; run `just check` (refreshes `Cargo.lock`); move the
  `.codegraph/.references/pi` checkout to the release commit, re-run
  `codegraph index`, and re-record `src-tauri/tests/fixtures` against the new
  binary (`src-tauri/tests/scripts/README.md`). The SSH test host follows the
  pin too: `PI_VERSION` and `PI_SHA256` in `src-tauri/tests/pi-host/Dockerfile`,
  where the hash is the one from the release's `SHA256SUMS`; a test compares
  that argument against this crate's version, so a stale one fails
  `just rust-test`. The protocol crate moves with the same release: its
  `[package.metadata.pi_rpc] pi_rev` names the release commit, and this app then
  updates the dependency (`cargo update -p pi_rpc`) so `Cargo.lock` records the
  revision - `src-tauri/tests/conformance.rs` reads the recorded corpus through
  that crate.
- `devenv.nix` is formatted by nixfmt — keep its multi-line style.
- prettier/eslint hooks deliberately use `node_modules/.bin` binaries (version
  parity with local dev) — don't point them at nixpkgs versions.
- Rust commands (`cargo`, `rustc`) come from the rust-overlay toolchain — don't
  add `pkgs.rustc` etc. to `devenv.nix`.

## Gotchas

- React never interprets the wire: `src/lib/rpc-protocol.ts` holds types only,
  and they come from pi's own packages — parsing, framing and degradation stay
  in Rust.
- The `pi_rpc` crate (https://github.com/kui04/pi_rpc) mirrors Pi's wire
  protocol, not Tauri's needs: it holds no connection policy, and an unmapped
  record must degrade to that crate's `Unknown` instead of failing the
  connection. Its pi pin is its own `[package.metadata.pi_rpc]`, and the
  revision this app builds against is the one in `Cargo.lock`.
- pnpm 11 keeps build-script approvals in `pnpm-workspace.yaml`; esbuild is
  deliberately `false`, and a `set this to true or false` stub fails every
  `pnpm <script>`.
- Logs go through `tracing` + `tracing-subscriber` (`src-tauri/src/log.rs`):
  stderr on desktop, logcat on Android, because a device shows neither stdout
  nor stderr. `RUST_LOG` _replaces_ the default `info` level rather than adding
  to it — use `RUST_LOG=info,pi_rpc=debug` to keep app logs while raising one
  target.
- `RUSTFLAGS` contains mold flags (desktop x86_64). For Android cargo builds
  linking through the NDK toolchain, unset `RUSTFLAGS` if linking fails.
- Pinned nixpkgs quirks: no `javascriptcoregtk_*` (merged into `webkitgtk_4_1`);
  libxdo comes from `pkgs.xdotool`. Check attrs with `nix eval` before adding
  packages.
- The Android SDK is unfree; licenses are pre-accepted in `devenv.yaml`.
- `src-tauri/gen/android/app/build.gradle.kts` pins `compileSdk`/`targetSdk` to
  36 to match the provided SDK; Tauri's generator emits 37 — re-lower it if the
  project is regenerated.
