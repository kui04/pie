# AGENTS.md

## Overview and layout

Pie is a mobile-first, cross-platform GUI for
[Pi](https://github.com/earendil-works/pi) built with Tauri 2, React 19,
TypeScript, Vite 8, and Rust. React renders UI and UI state only; Rust owns all
logic and drives `pi --mode rpc` (JSONL over stdio) locally or over SSH.

- `src/routes/`: screen trees (`connect/`, `chat/`).
- `src/components/ui/`: unmodified `shadcn` primitives (`base-nova` on
  `@base-ui/react`); checked by `pnpm ui-check`.
- `src/components/`: app components (`ScrollPane`, `CodeBlock`, `Markdown`,
  `TruncatedText`, `Icon`, `Hourglass`, `dialog/`, `layout/`).
- `src/machines/`, `src/stores/`, `src/hooks/`: XState v5 machines, Zustand
  stores, and shared hooks (`@/hooks`).
- `src/lib/`: domain modules (`bridge/`, `extension/`, `highlight/`, `query/`,
  `session/`, `transcript/`) and `rpc-protocol.ts` (type aliases over
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`).
- `src-tauri/src/`: layered Rust backend
  (`commands -> state -> host -> channel -> pi_rpc`; `session` is a peer of
  `host`), plus `bus.rs`, `error.rs`, `log.rs`, and `state.rs`.
- `src-tauri/gen/android/`: committed Android Gradle project (`gen/schemas` is
  ignored).
- `.codegraph/.references/pi`: untracked Pi source checkout at
  `abe508e1b89912adde45528136c3221eb69acdd7` (tag `v1.1.0`, indexed by
  `codegraph.json`). Read it for real Pi APIs; recreate with
  `git clone https://github.com/earendil-works/pi .codegraph/.references/pi && git -C .codegraph/.references/pi checkout <hash>`.

## Architecture rules

Read and strictly follow the matching rule file BEFORE writing code — they are
contracts, not suggestions. Deviations require explicit user approval.

- All changes: `.agents/rules/architecture.md`
- `src-tauri/src/channel/**`, `src-tauri/src/host/**`, or the `pi_rpc` crate:
  `.agents/rules/pi-rpc.md`
- `src/**` (React UI and markup): `.agents/rules/frontend.md`
- `src/**` (state, queries, machines, stores): `.agents/rules/state.md`

## Setup

[devenv](https://devenv.sh) provides Rust stable (rust-overlay, mold), pnpm,
Node, Android SDK/NDK + JDK, and Tauri Linux dependencies; `direnv` loads it via
`.envrc`.

- Run `pnpm install` once (`node_modules/` is not Nix-managed).
- Run `devenv update` after editing `devenv.yaml` inputs.
- Never edit `local.properties`, `.devenv/`, or `.direnv/` (auto-generated).

## Commands

`package.json` scripts are the source of truth (`pnpm run`). Run fast, scoped
checks while iterating, and full checks before finishing.

- **Single frontend test**:
  `pnpm vitest run src/path/to/file.test.tsx -t "test name"`
- **Single Rust test**: `cd src-tauri && cargo test <test_name>`
- **Frontend suites**: `pnpm test` (Vitest), `pnpm lint` (ESLint), `pnpm format`
  / `pnpm format:check` (Prettier), `pnpm build` (`tsc && vite build` — the only
  command that typechecks TS and verifies `src/lib/rpc-protocol.ts`).
- **UI registry check**: `pnpm ui-check` (verifies `src/components/ui/` matches
  unmodified `shadcn` output; requires network).
- **Rust checks**: `pnpm check`, `pnpm clippy` (`--all-targets -- -D warnings`),
  `pnpm rust-test`, `pnpm doc` (`RUSTDOCFLAGS="-D warnings"`).
- **End-to-end**: `pnpm e2e:env`, `pnpm e2e:android`, `pnpm e2e:linux`,
  `pnpm e2e:real` (the real host needs `e2e/.testenv/real.env`, which is
  ignored; the Linux target uses WebdriverIO with `tauri-driver` and Xvfb); see
  `e2e/README.md`.
- **Test map**: `TESTING.md` says which layer owns a behavior; `e2e/CASES.md`
  lists the end-to-end cases and platform coverage.
- **Desktop and preview**: `pnpm app:dev`, `pnpm app:build`, `pnpm storybook`,
  `pnpm build-storybook`. Do not use `pnpm dev` alone to preview the app in a
  browser — the frontend queries Rust for the platform before rendering.
- **Android**: `pnpm android:dev`, `pnpm android:build` (requires a connected
  device; no AVD is configured).

## Commits and hooks

- **Format**: [Conventional Commits](https://www.conventionalcommits.org/)
  `type(scope): summary` — imperative, lowercase, no period (`feat`, `fix`,
  `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`). Add a body only
  for a non-obvious why.
- **Git hooks**: `prek` runs `nixfmt`, `prettier`, `eslint --fix`, and `rustfmt`
  on commit (`pnpm hooks` runs all manually). If a hook rewrites files, review
  the diff, `git add` again, and re-commit. Run `pnpm clippy` manually before
  pushing.

## Repository conventions and traps

- **Alphabetical Cargo manifest**: `src-tauri/Cargo.toml` keeps `[dependencies]`
  and `[dev-dependencies]` in alphabetical order.
- **Test and story layout**: mirror the component tree under `__tests__` and
  `__stories__`; do not flatten nested tests at the route root; move files
  whole, and do not split them only for layout.
- **Self-contained code comments**: Cite only sources a reader outside this
  working tree can look up (this repo's code, OpenSSH/russh source, or Pi at the
  pinned revision). Never cite `docs/` in committed files.
- **Version bumps** (tracks the
  [Pi release](https://github.com/earendil-works/pi/releases), currently
  `1.1.0`):
  1. Update `package.json`, `src-tauri/tauri.conf.json`, and
     `src-tauri/Cargo.toml`.
  2. Move `.codegraph/.references/pi` to the release commit and re-run
     `codegraph index`.
  3. Update `pi_rpc` (whose `[package.metadata.pi_rpc] pi_rev` names the Pi
     commit its protocol was recorded from) and run `cargo update -p pi_rpc` and
     `pnpm check`.
- **Logging**: `src-tauri/src/log.rs` routes `tracing` to stderr on desktop and
  logcat on Android. `RUST_LOG` replaces the default `info,pie_lib=debug` filter
  — use `RUST_LOG=info,pie_lib=debug,pi_rpc=debug` to raise one target without
  silencing app logs.
- **Nix and toolchain quirks**:
  - Keep `devenv.nix` in multi-line `nixfmt` style; never add `pkgs.rustc` or
    `pkgs.cargo` (provided by `rust-overlay`), and keep `prettier`/`eslint`
    hooks pointed at `./node_modules/.bin/`.
  - `webkitgtk_4_1` includes JavaScriptCore; `libxdo` comes from `pkgs.xdotool`.
    Verify attributes with `nix eval` before adding packages.
  - `pnpm-workspace.yaml` stores pnpm 11 build-script approvals under
    `allowBuilds` (`esbuild: false` and the two type-only packages). pnpm stops
    every command while a package it wants to build has no answer there.
  - Unset `RUSTFLAGS` (which carries desktop x86_64 `mold` flags) if Android NDK
    cargo linking fails.
  - `src-tauri/gen/android/app/build.gradle.kts` pins `compileSdk` and
    `targetSdk` to `36` to match `devenv.nix`; re-lower from `37` if
    regenerated.
