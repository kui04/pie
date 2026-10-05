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

# rustdoc, with a link to a private item treated as an error (nothing else runs it)
doc:
    cd src-tauri && RUSTDOCFLAGS="-D warnings" cargo doc --no-deps

# rust tests, including the real-pi one when it is asked for
rust-test:
    cd src-tauri && cargo test

# regenerate the frontend's protocol types (src/lib/protocol) from the Rust mirror
types:
    rm -rf src/lib/protocol
    cd src-tauri && cargo test --lib export_bindings

# The generated types are what the protocol generates, and nothing generated is
# untracked. Green means the next commit carries the types the protocol produces:
# the check compares the worktree (regenerated) with the index, so a staged update
# passes, and a copy that only HEAD is missing is reported instead of failed.
types-check:
    just types
    @test -z "$(git diff --name-only -- src/lib/protocol)" || { echo "the staged copy is not what the protocol generates:"; git diff --stat -- src/lib/protocol; echo "stage the regenerated files"; exit 1; }
    @test -z "$(git ls-files --others --exclude-standard -- src/lib/protocol)" || { echo "generated files are not under version control:"; git ls-files --others --exclude-standard -- src/lib/protocol; exit 1; }
    @if ! git diff --quiet HEAD -- src/lib/protocol; then echo "note: the generated types differ from the last commit - include them in this one"; fi

# the sshd the SSH transport tests talk to (builds tests/pi-host, prints exports)
ssh-fixture:
    bash src-tauri/tests/scripts/ssh-fixture.sh start

# SSH tests against that sshd and a real pi (starts the fixture): the transport
# layer, and the app's connection layer over it.
# Repeats the line above on purpose: just does not hand a dependency's output to
# the recipe that depends on it, and the coordinates reach the tests as
# environment variables. One test at a time: they share one host, and one of them
# counts what that host is left holding.
ssh-test:
    eval "$(bash src-tauri/tests/scripts/ssh-fixture.sh start)" && cd src-tauri && cargo test --test ssh --test connection -- --ignored --test-threads=1

# frontend unit/component tests (vitest)
test:
    pnpm test

# run all git hooks on all files
hooks:
    prek run --all-files