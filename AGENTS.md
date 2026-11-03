# AGENTS.md

## Rules

Read the matching file before you write code; they are contracts, and a
deviation needs the user's approval.

- All changes: `.agents/rules/architecture.md`
- `src/**` (React UI and markup): `.agents/rules/frontend.md`
- `src/**` (state, queries, machines, stores): `.agents/rules/state.md`
- Tests, stories, fixtures (`src/**/__tests__`, `src/**/__stories__`,
  `src-tauri/**`, `e2e/**`): `.agents/rules/testing.md`
- `src-tauri/src/channel/**`, `src-tauri/src/host/**`, the `pi_rpc` crate:
  `.agents/rules/pi-rpc.md`

## Commands

- `pnpm install` once: `node_modules/` is not Nix-managed, and the git hooks run
  `./node_modules/.bin/`.
- `pnpm build` (`tsc && vite build`) is the only TypeScript typecheck.
- One test: `pnpm vitest run <file> -t "<name>"`, or
  `cd src-tauri && cargo test <name>`.
- `pnpm dev` alone serves a blank page: `src/App.tsx` waits for Rust to report
  the platform. Use `pnpm app:dev`, or `pnpm storybook` for one component.
- `pnpm android:dev` needs a connected device, and the devenv shell has no
  emulator to fall back on.
- End-to-end: `e2e/AGENTS.md` holds the host, the flow, and the filters;
  `e2e/CASES.md` lists the cases.
- The `prek` hooks run nixfmt, prettier, eslint --fix, and rustfmt, and nothing
  else. If a hook rewrites a file, review the diff, `git add` it again, and
  re-commit.
- No CI runs here: before you hand work back, run `pnpm test` and
  `pnpm rust-test` for the layer you touched, plus `pnpm lint`, `pnpm build`,
  `pnpm clippy`, and `pnpm doc` (which denies rustdoc warnings).
- Commit messages: `type(scope): summary`, imperative, lowercase, no period
  (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`).

## Traps

- `.codegraph/.references/pi` is an untracked checkout of Pi v1.1.0
  (`abe508e1b89912adde45528136c3221eb69acdd7`): read its source for the real Pi
  APIs. Recreate it with
  `git clone https://github.com/earendil-works/pi .codegraph/.references/pi`,
  check out that commit, and run `codegraph index`.
- A code comment names a source a reader outside this tree can open: this repo
  (`.agents/rules/` included), the OpenSSH or russh source, or Pi v1.1.0. It
  never names the checkout path.
- Log through `tracing`. `RUST_LOG` replaces the filter in
  `src-tauri/src/log.rs`, which defaults to `info,pie_lib=debug`.
- Unset `RUSTFLAGS` when Android NDK linking fails: it carries the desktop
  x86_64 mold flags.
- `src-tauri/gen/android/app/build.gradle.kts` pins `compileSdk` and `targetSdk`
  to 36 to match `devenv.nix`. Lower them again from 37 if the file is
  regenerated.
- `devenv.nix` takes Rust from `rust-overlay` and points the prettier and eslint
  hooks at `./node_modules/.bin/`; both break if changed.
