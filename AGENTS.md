# AGENTS.md

## Project overview

Pie is a cross-platform GUI for [Pi](https://github.com/earendil-works/pi),
mobile first. Tauri 2: React 19 + TypeScript + Vite 8 frontend in `src/`, Rust
backend in `src-tauri/`, committed Android Gradle project in
`src-tauri/gen/android/` (only `gen/schemas` is ignored). Pi's wire protocol is
`src-tauri/src/pi_rpc/`, a module of the app crate whose boundary the tests
enforce (`src-tauri/tests/purity.rs`); the version tracks the Pi release.

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
- `src-tauri/src/pi_rpc/**` or any transport code: `.agents/rules/pi-rpc.md`
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

- Desktop: `just dev` (dev), `just build` (release); frontend only: `just web` /
  `just web-build`; component preview: `just storybook` /
  `just storybook-build`.
- Android: `just android-dev`, `just android-build` — needs a connected device,
  no AVD is provided.
- Rust: `just check`, `just clippy` (warnings are errors, all targets),
  `just rust-test` — all inside `src-tauri`, where the app and the `pi_rpc`
  module live. Ignored tests start a real `pi`: run them with
  `cd src-tauri && cargo test -- --ignored` after bumping the pin, and
  `just ssh-test` for the SSH transport, which brings up its own sshd in a
  container (`just ssh-fixture` to keep one running).
- JS: `just lint`, `just format`, `just test`.

Stories sit next to their component (`src/**/*.stories.tsx`) and replay the
recorded protocol corpus through `src/preview/fixtures.ts`. Statecharts are also
path-enumerated with `@xstate/graph`
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

- UI primitives come from shadcn (`pnpm dlx shadcn@latest add <name>`) into
  `src/components/ui/` — generated, never hand-edited.
- Version tracks the latest
  [Pi release](https://github.com/earendil-works/pi/releases) (currently
  0.99.2). When bumping: edit `package.json`, `src-tauri/tauri.conf.json` and
  `src-tauri/Cargo.toml`; run `just check` (refreshes `Cargo.lock`); move the
  `.codegraph/.references/pi` checkout to the release commit, re-run
  `codegraph index`, and re-record `src-tauri/tests/fixtures` against the new
  binary (`src-tauri/tests/scripts/README.md`). The SSH test host follows the
  pin too: `PI_VERSION` and `PI_SHA256` in `src-tauri/tests/pi-host/Dockerfile`,
  where the hash is the one from the release's `SHA256SUMS`; a test compares
  that argument against the crate version, so a stale one fails
  `just rust-test`.
- `devenv.nix` is formatted by nixfmt — keep its multi-line style.
- prettier/eslint hooks deliberately use `node_modules/.bin` binaries (version
  parity with local dev) — don't point them at nixpkgs versions.
- Rust commands (`cargo`, `rustc`) come from the rust-overlay toolchain — don't
  add `pkgs.rustc` etc. to `devenv.nix`.

## Gotchas

- React never interprets the wire: `src/lib/protocol.ts` is types-only; parsing,
  framing and degradation stay in Rust.
- `src-tauri/src/pi_rpc` mirrors Pi's wire protocol, not Tauri's needs: it holds
  no connection policy, and an unmapped record must degrade to
  `ServerMessage::Unknown` instead of failing the connection.
- pnpm 11 keeps build-script approvals in `pnpm-workspace.yaml`; esbuild is
  deliberately `false`, and a `set this to true or false` stub fails every
  `pnpm <script>`.
- Logs go through `tracing` + `tracing-subscriber` (`src-tauri/src/logging.rs`):
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
