# AGENTS.md

## Project overview

Pie is a cross-platform GUI for [Pi](https://github.com/earendil-works/pi),
mobile first. Tauri 2 app: React 19 + TypeScript + Vite 8 frontend in `src/`,
Rust backend in `src-tauri/`, generated Android Gradle project in
`src-tauri/gen/android/` (committed; only `gen/schemas` is ignored).

## Setup

Everything comes from [devenv](https://devenv.sh); entering the project
directory auto-loads the environment via direnv (`.envrc`). It provides Rust
stable (rust-overlay, mold linker), pnpm, Node, the Android SDK/NDK + JDK, Tauri
Linux system deps, `just`, and `just-lsp`.

- Install frontend deps: `pnpm install` (only needed once; `node_modules/` is
  not Nix-managed)
- After editing `devenv.yaml` inputs: `devenv update`
- Never edit `local.properties`, `.devenv/`, `.direnv/` — auto-generated.

## Build and test

All recipes via [just](https://github.com/casey/just) (`just --list`):

- Desktop dev: `just dev`
- Frontend only: `just web`
- Frontend production build (tsc + vite): `pnpm build`
- Rust backend check: `just check` (= `cd src-tauri && cargo check`)
- Rust lints: `just clippy` (cargo clippy, warnings are errors)
- Lint: `just lint` (eslint 10, flat config in `eslint.config.js`)
- Format: `just format` (prettier; Tailwind class sorting via
  `prettier-plugin-tailwindcss`)
- Android dev/build: `just android-dev` / `just android-build` — requires a
  connected device; no emulator/AVD is provided by the environment.

There is no test framework yet — don't invent test commands.

## Git hooks

prek runs on commit (wired by devenv): nixfmt (`*.nix`), prettier, eslint
`--fix`, rustfmt (uses the rust-overlay toolchain, manifest pinned to
`src-tauri/Cargo.toml`). First commit may fail because hooks modify files —
review the diff, `git add` again, re-commit. Run all hooks manually:
`just hooks`.

## Conventions

- Version tracks the latest
  [Pi release](https://github.com/earendil-works/pi/releases) (currently
  0.99.2). When bumping, edit all three: `package.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, then run `just check` to
  refresh `Cargo.lock`.
- `devenv.nix` is formatted by nixfmt — keep its multi-line style.
- prettier/eslint hooks deliberately use `node_modules/.bin` binaries (version
  parity with local dev); don't point them at nixpkgs versions.
- Rust commands (`cargo`, `rustc`) come from the rust-overlay toolchain, not
  nixpkgs — don't add `pkgs.rustc` etc. to `devenv.nix`.

## Gotchas

- `RUSTFLAGS` in the environment contains mold linker flags (desktop x86_64).
  For Android cargo builds that link via the NDK toolchain, unset `RUSTFLAGS` if
  linking fails.
- nixpkgs attribute quirks in the pinned channel (devenv-nixpkgs rolling):
  `javascriptcoregtk_*` does not exist (merged into `webkitgtk_4_1`), libxdo
  comes from `pkgs.xdotool`. Verify attrs with `nix eval ... #legacyPackages`
  before adding packages.
- The Android SDK is unfree; licenses are pre-accepted in `devenv.yaml`
  (`nixpkgs.android_sdk.accept_license`).
