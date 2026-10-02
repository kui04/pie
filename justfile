# desktop app dev (window + hot reload)
dev:
    pnpm tauri dev

# frontend dev server only (http://localhost:1420)
web:
    pnpm dev

# frontend production build (tsc + vite)
web-build:
    pnpm build

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

# android release build
android-build:
    pnpm tauri android build

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

# rust tests, including the real-pi one when it is asked for
rust-test:
    cd src-tauri && cargo test

# the sshd the SSH transport tests talk to (builds tests/pi-host, prints exports)
ssh-fixture:
    bash src-tauri/tests/scripts/ssh-fixture.sh start

# SSH transport tests against that sshd and a real pi (starts the fixture).
# Repeats the line above on purpose: just does not hand a dependency's output to
# the recipe that depends on it, and the coordinates reach the tests as
# environment variables.
ssh-test:
    eval "$(bash src-tauri/tests/scripts/ssh-fixture.sh start)" && cd src-tauri && cargo test --test ssh -- --ignored

# frontend unit/component tests (vitest)
test:
    pnpm test

# run all git hooks on all files
hooks:
    prek run --all-files