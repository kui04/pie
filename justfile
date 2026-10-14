# desktop app dev (window + hot reload)
dev:
    pnpm tauri dev

# component preview (http://localhost:6006)
storybook:
    pnpm storybook

# static component preview build (storybook-static/)
storybook-build:
    pnpm build-storybook

# release build
build:
    pnpm tauri build

# android dev on a connected device
android-dev:
    pnpm tauri android dev

# android release build: arm64 only, the architecture a phone really is
android-build:
    pnpm tauri android build --target aarch64

# eslint
lint:
    pnpm lint

# prettier --write .
format:
    pnpm format

# cargo check
check:
    cd src-tauri && cargo check

# cargo clippy (warnings are errors)
clippy:
    cd src-tauri && cargo clippy --all-targets -- -D warnings

# rustdoc, with a link to a private item treated as an error (nothing else runs it)
doc:
    cd src-tauri && RUSTDOCFLAGS="-D warnings" cargo doc --no-deps

# rust tests, including the real-pi one when it is asked for
rust-test:
    cd src-tauri && cargo test

# the sshd the SSH channel tests talk to (builds tests/pi-host, prints exports)
ssh-fixture:
    bash src-tauri/tests/scripts/ssh-fixture.sh start

# SSH tests against that sshd and a real pi (starts the fixture): the reach to a
# machine, and the sessions of that machine over it.
# Repeats the line above on purpose: just does not hand a dependency's output to
# the recipe that depends on it, and the coordinates reach the tests as
# environment variables. One test at a time: they share one host, and one of them
# counts what that host is left holding.
ssh-test:
    eval "$(bash src-tauri/tests/scripts/ssh-fixture.sh start)" && cd src-tauri && cargo test --test ssh --test session -- --ignored --test-threads=1

# frontend unit/component tests (vitest)
test:
    pnpm test

# run all git hooks on all files
hooks:
    prek run --all-files

# the primitives under src/components/ui/ against a fresh install of the same
# components: a file there is never hand-edited (needs the network)
ui-check:
    bash scripts/ui-check.sh