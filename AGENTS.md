# AGENTS.md

## Project overview

Pie is a cross-platform GUI for [Pi](https://github.com/earendil-works/pi),
mobile first. Tauri 2: React 19 + TypeScript + Vite 8 frontend in `src/`, Rust
backend in `src-tauri/`, committed Android Gradle project in
`src-tauri/gen/android/` (only `gen/schemas` is ignored).

Pi's source is checked out at `.codegraph/.references/pi` (untracked, indexed by
CodeGraph via `codegraph.json`) — read it for real Pi APIs instead of guessing.
Pinned at `ed8b3bcc194c8263ec8bec3f337053ae73866da1` (main); recreate with
`git clone https://github.com/earendil-works/pi .codegraph/.references/pi` and
`git -C .codegraph/.references/pi checkout <hash>`.

## Setup

[devenv](https://devenv.sh) provides the environment; direnv auto-loads it on
`cd` (`.envrc`). It has Rust stable (rust-overlay, mold), pnpm, Node, the
Android SDK/NDK + JDK, Tauri Linux deps, `just`, and `just-lsp`.

- `pnpm install` once — `node_modules/` is not Nix-managed.
- `devenv update` after editing `devenv.yaml` inputs.
- Never edit `local.properties`, `.devenv/`, `.direnv/` — auto-generated.

## Build and test

Recipes via [just](https://github.com/casey/just) (`just --list`):

- Desktop: `just dev` (dev), `just build` (release); frontend only: `just web`
- Android: `just android-dev`, `just android-build` — needs a connected device,
  no AVD is provided.
- Rust: `just check` (cargo check), `just clippy` (warnings are errors)
- JS: `just lint` (eslint 10, `eslint.config.js`), `just format` (prettier with
  Tailwind class sorting), `pnpm build` (tsc + vite)

No test framework yet — don't invent test commands.

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

- Version tracks the latest
  [Pi release](https://github.com/earendil-works/pi/releases) (currently
  0.99.2). When bumping: edit `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`; run `just check` (refreshes `Cargo.lock`); move the
  `.codegraph/.references/pi` checkout to the release commit and re-run
  `codegraph index`.
- `devenv.nix` is formatted by nixfmt — keep its multi-line style.
- prettier/eslint hooks deliberately use `node_modules/.bin` binaries (version
  parity with local dev) — don't point them at nixpkgs versions.
- Rust commands (`cargo`, `rustc`) come from the rust-overlay toolchain — don't
  add `pkgs.rustc` etc. to `devenv.nix`.

## Gotchas

- `RUSTFLAGS` contains mold flags (desktop x86_64). For Android cargo builds
  linking through the NDK toolchain, unset `RUSTFLAGS` if linking fails.
- Pinned nixpkgs quirks: no `javascriptcoregtk_*` (merged into `webkitgtk_4_1`);
  libxdo comes from `pkgs.xdotool`. Check attrs with `nix eval` before adding
  packages.
- The Android SDK is unfree; licenses are pre-accepted in `devenv.yaml`.
- `src-tauri/gen/android/app/build.gradle.kts` pins `compileSdk`/`targetSdk` to
  36 to match the provided SDK; Tauri's generator emits 37 — re-lower it if the
  project is regenerated.
